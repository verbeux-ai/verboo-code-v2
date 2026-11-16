/** Sign the packaged Node runtime and require Apple's distribution checks before publication. */
import { execFile } from 'node:child_process'
import { createHash, createPrivateKey } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertMacOSSignatureDetails, assertMacOSRuntimeSignatureDetails } from '../scripts/macos-signature-details.mjs'

const execute = promisify(execFile)
const entitlements = join(dirname(fileURLToPath(import.meta.url)), 'runtime-entitlements.plist')
const machOMagics = new Set(['cafebabe', 'cafebabf', 'cefaedfe', 'cffaedfe', 'feedface', 'feedfacf', 'bebafeca', 'bfbafeca'])
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

/**
 * Execute a bounded Apple tool without exposing private arguments on failure.
 * @param command - Trusted executable path.
 * @param args - Tool arguments, never included in failure reports.
 * @param options - Process options and optional streaming of trusted build output.
 * @returns Captured stdout and stderr after the tool exits successfully.
 */
export async function apple(command, args, options = {}) {
  const { stream = false, ...executionOptions } = options
  try {
    const operation = execute(command, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 4 << 20, ...executionOptions })
    if (stream) {
      operation.child.stdout.pipe(process.stdout)
      operation.child.stderr.pipe(process.stderr)
    }
    const { stdout, stderr } = await operation
    return { stdout, stderr }
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`
    const terminalHTTP = /HTTP[^\n]{0,60}\b(?:400|401|403|404|409|422)\b/i.test(output)
    const retryable = !terminalHTTP && !executionOptions.signal?.aborted && (error.killed
      || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(error.code)
      || /NSURLErrorDomain[^\n]*Code=-(?:1001|1003|1004|1005|1006|1009)\b|network connection was lost|connection (?:reset|timed out)|request timed out|HTTP[^\n]{0,60}\b(?:408|429|5\d\d)\b/i.test(output))
    const retryAfter = /\bRetry-After:\s*([^\r\n]+)/i.exec(output)?.[1].trim()
    const delay = retryAfter && (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now())
    const retryAfterMs = Number.isFinite(delay) && delay >= 0 ? delay : undefined
    throw Object.assign(new Error(`macOS release: ${command} ${args[0] ?? ''} failed (${error.killed ? 'timeout or interruption' : error.code ?? 'execution error'})`), { retryable, retryAfterMs })
  }
}

/**
 * Read the exact Developer ID identity; ad-hoc and development certificates are rejected.
 * @param environment - Public Apple signing identity and Team ID.
 * @returns The certificate qualifier and expected team.
 */
export function releaseIdentity(environment) {
  const teamId = environment.APPLE_TEAM_ID
  const identity = environment.APPLE_SIGNING_IDENTITY
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? '') || typeof identity !== 'string'
    || !identity.startsWith('Developer ID Application: ') || !identity.endsWith(` (${teamId})`)
    || /[\r\n]/.test(identity)) throw new Error('macOS release: APPLE_SIGNING_IDENTITY must be a Developer ID Application identity belonging to APPLE_TEAM_ID')
  return { signingIdentity: identity.slice('Developer ID Application: '.length), teamId }
}

/**
 * Validate all CI secrets before starting a build without disclosing their values.
 * @param environment - Repository Actions secrets.
 * @returns The validated public signing identity.
 */
export function validateAppleCredentials(environment) {
  const required = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_PRIVATE_KEY']
  const missing = required.filter(name => !environment[name]?.trim())
  if (missing.length) throw new Error(`macOS release: missing GitHub Actions secrets: ${missing.join(', ')}`)
  const identity = releaseIdentity(environment)
  if (!/^[A-Z0-9]{10}$/.test(environment.APPLE_API_KEY)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(environment.APPLE_API_ISSUER)) throw new Error('macOS release: invalid App Store Connect Key ID or Issuer ID; use a team API key')
  const encoded = environment.APPLE_CERTIFICATE.replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw new Error('macOS release: APPLE_CERTIFICATE must contain the base64-encoded PKCS#12 certificate and private key')
  try {
    const key = createPrivateKey(environment.APPLE_API_PRIVATE_KEY)
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('invalid API key')
  } catch (error) {
    throw new Error('macOS release: APPLE_API_PRIVATE_KEY must contain the downloaded App Store Connect .p8 private key')
  }
  return identity
}

/** Find real Mach-O files, including addons and helpers; never traverse symbolic links. */
async function nativeFiles(root) {
  const files = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const file = await open(path, 'r')
    try {
      const header = Buffer.alloc(4)
      const { bytesRead } = await file.read(header, 0, 4, 0)
      if (bytesRead === 4 && machOMagics.has(header.toString('hex'))) files.push(path)
    } finally { await file.close() }
  }
  return files.sort()
}

/** Verify every architecture's signature, company identity, timestamp and hardened runtime. */
async function verifyCode(path, expected, run, deep = false) {
  await run('/usr/bin/codesign', ['--verify', '--all-architectures', '--strict', ...(deep ? ['--deep'] : []), path])
  const details = await run('/usr/bin/codesign', ['--display', '--verbose=4', path])
  assertMacOSRuntimeSignatureDetails(details.stdout + details.stderr, expected)
}

/**
 * Sign each embedded Mach-O before Tauri seals the application, preserving Node's JIT and native addons.
 * @param root - Private, materialized runtime directory.
 * @param environment - Public signing identity and the owned signing keychain.
 * @param run - Bounded Apple command executor.
 * @returns The number of native files signed and verified.
 */
export async function signRuntime(root, environment, run = apple) {
  const expected = releaseIdentity(environment)
  if (!environment.CSC_KEYCHAIN) throw new Error('macOS release: the temporary signing keychain is required')
  if (existsSync(join(root, 'application/packages'))) throw new Error('macOS release: discard workspace package archives before Apple signing')
  const files = await nativeFiles(root)
  if (!files.includes(join(root, 'node'))) throw new Error('macOS release: the native Node runtime is missing')
  for (const path of files) {
    const identifier = `ai.verbeux.verboo-code.runtime.${createHash('sha256').update(relative(root, path)).digest('hex')}`
    await run('/usr/bin/codesign', ['--force', '--sign', environment.APPLE_SIGNING_IDENTITY, '--keychain', environment.CSC_KEYCHAIN,
      '--timestamp', '--options', 'runtime', '--identifier', identifier,
      ...(path === join(root, 'node') || path.endsWith('/libreoffice-kit') ? ['--entitlements', entitlements] : []), path])
    await verifyCode(path, expected, run)
  }
  return files.length
}

/**
 * Require the sealed application, every runtime binary, a stapled ticket and Gatekeeper acceptance.
 * @param application - Built or extracted application bundle.
 * @param environment - Expected public release identity.
 * @param run - Bounded Apple command executor.
 * @returns After all checks pass; a failed check prevents publication.
 */
export async function verifyApplication(application, environment, run = apple) {
  const expected = releaseIdentity(environment)
  await verifyCode(application, expected, run, true)
  const runtime = join(application, 'Contents/Resources/runtime')
  const files = await nativeFiles(runtime)
  if (!files.includes(join(runtime, 'node'))) throw new Error('macOS release: the installed Node runtime is missing')
  for (const path of files) await verifyCode(path, expected, run)
  await run('/usr/bin/xcrun', ['stapler', 'validate', application], { stream: true })
  await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', application])
}

/**
 * Poll one uploaded submission for at most 20 minutes; never resubmit an installer.
 * Each status read allows ten seconds and at most three transient transport attempts
 * within 35 seconds, honoring Retry-After when the tool supplies it. Authentication,
 * invalid responses and rejection stop immediately.
 * @param id - The UUID returned after a successful upload.
 * @param environment - Materialized App Store Connect credentials.
 * @param run - Bounded Apple command executor.
 * @param timing - Monotonic clock, bounded pause and public status reporter.
 * @returns Only after this exact submission is Accepted.
 */
export async function waitForNotarization(id, environment, run = apple, {
  now = () => performance.now(), pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), report = message => console.log(message),
} = {}) {
  if (!uuid.test(id ?? '')) throw new Error('macOS release: Apple did not return a valid submission ID')
  const deadline = now() + 20 * 60_000
  let failures = 0
  let readDeadline
  let previous
  while (now() < deadline) {
    if (failures === 0) readDeadline = Math.min(deadline, now() + 35_000)
    if (now() >= readDeadline) throw new Error(`macOS release: Apple status query failed for submission ${id}`)
    let result
    try {
      result = await run('/usr/bin/xcrun', ['notarytool', 'info', id, '--key', environment.APPLE_API_KEY_PATH,
        '--key-id', environment.APPLE_API_KEY, '--issuer', environment.APPLE_API_ISSUER, '--output-format', 'json'], { timeout: Math.max(1, Math.floor(Math.min(10_000, readDeadline - now()))) })
    } catch (error) {
      const delay = Math.max((failures + 1) * 1000, error.retryAfterMs ?? 0)
      if (!error.retryable || ++failures === 3 || now() + delay >= readDeadline) throw new Error(`macOS release: Apple status query failed for submission ${id}`)
      report(`Verboo Code: retrying the Apple status query for ${id} (${failures + 1}/3)`)
      await pause(delay)
      continue
    }
    failures = 0
    let submission
    try { submission = JSON.parse(result.stdout) } catch { throw new Error(`macOS release: invalid Apple status response for submission ${id}`) }
    if (!submission || submission.id !== id || !['In Progress', 'Accepted', 'Invalid', 'Rejected'].includes(submission.status)) throw new Error(`macOS release: unexpected Apple status response for submission ${id}`)
    if (submission.status !== previous) report(`Verboo Code: Apple notarization ${id}: ${submission.status}`)
    previous = submission.status
    if (submission.status === 'Accepted') return
    if (submission.status !== 'In Progress') throw new Error(`macOS release: Apple did not accept the disk image (${submission.status}; submission ${id})`)
    await pause(Math.max(0, Math.min(10_000, deadline - now())))
  }
  throw new Error(`macOS release: Apple notarization exceeded 20 minutes; submission ${id}`)
}

/**
 * Sign and notarize the final DMG; rejection, timeout, missing tickets or Gatekeeper failure stop publication.
 * @param image - Final disk image containing the stapled application.
 * @param environment - Signing keychain and materialized App Store Connect credentials.
 * @param run - Bounded Apple command executor.
 * @returns After Apple accepts the image, its ticket is stapled and Gatekeeper accepts it.
 */
export async function notarizeDiskImage(image, environment, run = apple) {
  const expected = releaseIdentity(environment)
  if (!environment.CSC_KEYCHAIN || !environment.APPLE_API_KEY_PATH || !environment.APPLE_API_KEY || !environment.APPLE_API_ISSUER) throw new Error('macOS release: signing keychain and notarization credentials are required')
  await run('/usr/bin/codesign', ['--force', '--sign', environment.APPLE_SIGNING_IDENTITY, '--keychain', environment.CSC_KEYCHAIN, '--timestamp', image])
  await run('/usr/bin/codesign', ['--verify', '--strict', image])
  const details = await run('/usr/bin/codesign', ['--display', '--verbose=4', image])
  assertMacOSSignatureDetails(details.stdout + details.stderr, expected)
  const result = await run('/usr/bin/xcrun', ['notarytool', 'submit', image, '--key', environment.APPLE_API_KEY_PATH,
    '--key-id', environment.APPLE_API_KEY, '--issuer', environment.APPLE_API_ISSUER,
    '--no-wait', '--output-format', 'json'], { timeout: 5 * 60_000 })
  let submission
  try { submission = JSON.parse(result.stdout) } catch { throw new Error('macOS release: invalid Apple upload response') }
  if (!submission || typeof submission.id !== 'string' || !uuid.test(submission.id)) throw new Error('macOS release: Apple did not return a valid submission ID')
  console.log(`Verboo Code: disk image uploaded to Apple; submission ${submission.id}`)
  await waitForNotarization(submission.id, environment, run)
  await run('/usr/bin/xcrun', ['stapler', 'staple', image], { stream: true })
  await run('/usr/bin/xcrun', ['stapler', 'validate', image], { stream: true })
  await run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', image])
}
