import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { apple, notarizeDiskImage, releaseIdentity, signRuntime, validateAppleCredentials, verifyApplication, waitForNotarization } from '../macos-signing.mjs'

const desktop = fileURLToPath(new URL('../..', import.meta.url))
const run = promisify(execFile)
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const credentials = {
  APPLE_CERTIFICATE: Buffer.from('fixture-pkcs12').toString('base64'), APPLE_CERTIFICATE_PASSWORD: 'fixture-export-password',
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Fixture Company (ABC1234567)', APPLE_TEAM_ID: 'ABC1234567',
  APPLE_API_KEY: 'KEY1234567', APPLE_API_ISSUER: '12345678-1234-1234-1234-123456789abc', APPLE_API_PRIVATE_KEY: privateKey,
  CSC_KEYCHAIN: '/private/fixture.keychain-db', APPLE_API_KEY_PATH: '/private/fixture.p8',
}
const details = `Authority=${credentials.APPLE_SIGNING_IDENTITY}\nTeamIdentifier=${credentials.APPLE_TEAM_ID}\nTimestamp=Nov 15, 2026\nCodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=3+0 location=embedded\n`
const submissionId = '11111111-2222-4333-8444-555555555555'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'verboo-apple-signing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function native(path, magic = 'cffaedfe') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.concat([Buffer.from(magic, 'hex'), Buffer.alloc(60)]))
}

function appleFixture({ status = 'Accepted', signature = details, fail, uploadResponse } = {}) {
  const calls = []
  return { calls, run: async (command, args, options) => {
    calls.push({ command, args, options })
    if (fail?.(command, args)) throw new Error('Apple tool failed')
    if (args.includes('submit') && uploadResponse !== undefined) return { stdout: uploadResponse, stderr: '' }
    if (args.includes('submit') || args.includes('info')) return { stdout: JSON.stringify({ status, id: submissionId }), stderr: '' }
    return { stdout: '', stderr: args.includes('--display') ? signature : '' }
  } }
}

test('requires every signing and notarization secret without disclosing values', () => {
  assert.equal(validateAppleCredentials(credentials).teamId, credentials.APPLE_TEAM_ID)
  for (const name of Object.keys(credentials).filter(name => !['CSC_KEYCHAIN', 'APPLE_API_KEY_PATH'].includes(name))) {
    assert.throws(() => validateAppleCredentials({ ...credentials, [name]: '' }), error => {
      assert.match(error.message, new RegExp(name))
      assert.ok(!error.message.includes(credentials.APPLE_CERTIFICATE_PASSWORD))
      assert.ok(!error.message.includes(privateKey))
      return true
    })
  }
  for (const identity of ['-', 'Apple Development: Fixture (ABC1234567)', 'Developer ID Application: Fixture (WRONG12345)']) {
    assert.throws(() => releaseIdentity({ ...credentials, APPLE_SIGNING_IDENTITY: identity }), /Developer ID Application/)
  }
  for (const [name, value] of [['APPLE_CERTIFICATE', 'malformed-base64'], ['APPLE_API_PRIVATE_KEY', 'not-a-private-key'], ['APPLE_API_ISSUER', 'wrong-issuer']]) {
    assert.throws(() => validateAppleCredentials({ ...credentials, [name]: value }))
  }
})

test('runs the credential preflight on a clean checkout without packaging dependencies', async t => {
  const root = await fixture(t)
  for (const name of ['tauri', 'scripts']) await mkdir(join(root, name))
  for (const name of ['tauri/macos-release.mjs', 'tauri/macos-signing.mjs', 'scripts/macos-signing-keychain.mjs', 'scripts/macos-signature-details.mjs']) {
    await copyFile(join(desktop, name), join(root, name))
  }
  const result = await run(process.execPath, [join(root, 'tauri/macos-release.mjs'), '--check'], { env: { ...process.env, ...credentials } })
  assert.match(result.stdout, /secrets are configured/)
  assert.ok(!result.stdout.includes(privateKey))
})

test('signs Node, extensionless helpers and native addons before the application seal', async t => {
  const root = await fixture(t)
  for (const path of ['node', 'application/node_modules/addon/extension.node', 'application/helper']) await native(join(root, path))
  await writeFile(join(root, 'application/index.js'), 'export const value = 1')
  if (process.platform !== 'win32') await symlink(join(root, 'node'), join(root, 'node-alias'))
  const f = appleFixture()
  assert.equal(await signRuntime(root, credentials, f.run), 3)
  const signed = f.calls.filter(call => call.args.includes('--sign'))
  assert.equal(signed.length, 3)
  assert.ok(signed.every(call => call.args.includes('--timestamp') && call.args.includes('runtime') && call.args.includes(credentials.CSC_KEYCHAIN)))
  assert.equal(signed.filter(call => call.args.includes('--entitlements')).length, 1)
  assert.equal(signed.find(call => call.args.includes('--entitlements')).args.at(-1), join(root, 'node'))
  assert.equal(f.calls.filter(call => call.args.includes('--all-architectures')).length, 3)
  assert.ok(!signed.some(call => call.args.at(-1).endsWith('node-alias')))
})

test('stops native signing on the first failure and rejects a missing Node runtime', async t => {
  const root = await fixture(t)
  const f = appleFixture()
  await assert.rejects(signRuntime(root, credentials, f.run), /Node runtime is missing/)
  assert.equal(f.calls.length, 0)
  await native(join(root, 'node'))
  await native(join(root, 'addon.node'))
  const archives = join(root, 'application/packages')
  await mkdir(archives, { recursive: true })
  await writeFile(join(archives, 'unsigned-native.tgz'), 'packed build input')
  await assert.rejects(signRuntime(root, credentials, f.run), /discard workspace package archives/)
  assert.equal(f.calls.length, 0)
  await rm(archives, { recursive: true })
  const failed = appleFixture({ fail: (_command, args) => args.includes('--sign') })
  await assert.rejects(signRuntime(root, credentials, failed.run), /Apple tool failed/)
  assert.equal(failed.calls.length, 1)
})

test('rejects ad-hoc, wrong-team and incomplete native signatures before notarization', async t => {
  const root = await fixture(t)
  await native(join(root, 'node'))
  for (const signature of ['Signature=adhoc\n', details.replace('TeamIdentifier=ABC1234567', 'TeamIdentifier=OTHER12345'), details.replace(/Timestamp=.+\n/, ''), details.replace('(runtime)', '(none)')]) {
    const f = appleFixture({ signature })
    await assert.rejects(signRuntime(root, credentials, f.run), /signature/)
    assert.ok(!f.calls.some(call => call.command.endsWith('xcrun')))
  }
})

test('requires runtime signatures, a stapled app ticket and Gatekeeper approval', async t => {
  const root = await fixture(t)
  const application = join(root, 'Verboo Code.app')
  await native(join(application, 'Contents/Resources/runtime/node'))
  const f = appleFixture()
  await verifyApplication(application, credentials, f.run)
  assert.ok(f.calls.some(call => call.args.join(' ').includes('stapler validate')))
  const gatekeeper = f.calls.find(call => call.command.endsWith('spctl') && call.args.includes('execute'))
  assert.ok(gatekeeper)
  assert.equal(gatekeeper.options.stream, true)
  for (const tool of ['xcrun', 'spctl']) {
    const failed = appleFixture({ fail: command => command.endsWith(tool) })
    await assert.rejects(verifyApplication(application, credentials, failed.run), /Apple tool failed/)
    if (tool === 'spctl') {
      assert.ok(failed.calls.some(call => call.command.endsWith('codesign') && call.args.includes('--verbose=4')))
      assert.ok(failed.calls.some(call => call.command.endsWith('syspolicy_check') && call.args[0] === 'distribution'))
    }
  }
})

test('accepts a DMG only after notarization, stapling and its primary-signature assessment', async () => {
  const f = appleFixture()
  await notarizeDiskImage('/private/fixture.dmg', credentials, f.run)
  const submission = f.calls.find(call => call.args.includes('submit'))
  assert.ok(submission.args.includes('--no-wait') && !submission.args.includes('--wait'))
  assert.equal(submission.options.timeout, 5 * 60_000)
  assert.equal(f.calls.filter(call => call.args.includes('submit')).length, 1)
  assert.ok(f.calls.some(call => call.args.includes('info') && call.args.includes(submissionId)))
  assert.ok(f.calls.some(call => call.args.join(' ').includes('stapler staple')))
  assert.ok(f.calls.some(call => call.args.join(' ').includes('stapler validate')))
  assert.ok(f.calls.at(-1).args.includes('context:primary-signature'))
  assert.equal(f.calls.at(-1).options.stream, true)
})

test('a failed upload or rejected Apple submission cannot staple or publish a DMG', async () => {
  for (const configuration of [{ status: 'Invalid' }, { status: 'Rejected' }, { fail: (_command, args) => args.includes('submit') }]) {
    const f = appleFixture(configuration)
    await assert.rejects(notarizeDiskImage('/private/fixture.dmg', credentials, f.run))
    assert.ok(!f.calls.some(call => call.args.includes('stapler')))
    assert.ok(!f.calls.some(call => call.command.endsWith('spctl')))
  }
})

test('an unconfirmed upload cannot start polling or stapling and does not expose its raw response', async () => {
  for (const uploadResponse of ['fixture-private-output', 'null', '{"status":"Accepted"}', '{"id":"fixture-private-output"}']) {
    const f = appleFixture({ uploadResponse })
    await assert.rejects(notarizeDiskImage('/private/fixture.dmg', credentials, f.run), error => {
      assert.ok(!error.message.includes('fixture-private-output'))
      return true
    })
    assert.equal(f.calls.filter(call => call.args.includes('submit')).length, 1)
    assert.ok(!f.calls.some(call => call.args.includes('info') || call.args.includes('stapler')))
  }
})

test('recovers a status connection failure using the same uploaded submission without another write', async () => {
  let clock = 0
  const pauses = []
  const calls = []
  const responses = ['In Progress', Object.assign(new Error('transport'), { retryable: true }), 'Accepted']
  await waitForNotarization(submissionId, credentials, async (_command, args) => {
    calls.push(args)
    const response = responses.shift()
    if (response instanceof Error) throw response
    return { stdout: JSON.stringify({ id: submissionId, status: response }), stderr: '' }
  }, { now: () => clock, pause: async milliseconds => { pauses.push(milliseconds); clock += milliseconds }, report: () => {} })
  assert.equal(calls.length, 3)
  assert.ok(calls.every(args => args[1] === 'info' && args[2] === submissionId))
  assert.deepEqual(pauses, [10_000, 1000])
})

test('bounds transient status reads to three attempts within 35 seconds and never retries authentication', async () => {
  for (const retryable of [true, false]) {
    let clock = 0
    let calls = 0
    await assert.rejects(waitForNotarization(submissionId, credentials, async (_command, _args, options) => {
      calls++
      clock += options.timeout
      throw Object.assign(new Error('fixture-private-output'), { retryable })
    }, { now: () => clock, pause: async milliseconds => { clock += milliseconds }, report: () => {} }), error => {
      assert.match(error.message, /status query failed/)
      assert.ok(error.message.includes(submissionId) && !error.message.includes('fixture-private-output'))
      return true
    })
    assert.equal(calls, retryable ? 3 : 1)
    assert.ok(clock <= 35_000)
  }
})

test('pending, malformed, rejected and mismatched submissions cannot be mistaken for acceptance', async () => {
  for (const response of [JSON.stringify({ id: submissionId, status: 'In Progress' }), JSON.stringify({ id: submissionId, status: 'Invalid' }), JSON.stringify({ id: submissionId, status: 'Rejected' }), JSON.stringify({ id: 'another-submission', status: 'Accepted' }), 'fixture-private-output', 'null']) {
    let clock = 0
    let calls = 0
    await assert.rejects(waitForNotarization(submissionId, credentials, async () => {
      calls++
      return { stdout: response, stderr: '' }
    }, { now: () => clock, pause: async () => { clock += 20 * 60_000 }, report: () => {} }), error => {
      assert.ok(!error.message.includes('fixture-private-output'))
      return true
    })
    assert.equal(calls, 1)
  }
})

test('honors a provider retry delay and stops when that delay exceeds the status-read budget', async () => {
  for (const retryAfterMs of [5000, 60_000]) {
    let clock = 0
    let calls = 0
    const pauses = []
    const operation = waitForNotarization(submissionId, credentials, async () => {
      if (++calls === 1) throw Object.assign(new Error('rate limited'), { retryable: true, retryAfterMs })
      return { stdout: JSON.stringify({ id: submissionId, status: 'Accepted' }), stderr: '' }
    }, { now: () => clock, pause: async milliseconds => { pauses.push(milliseconds); clock += milliseconds }, report: () => {} })
    if (retryAfterMs < 35_000) {
      await operation
      assert.deepEqual(pauses, [retryAfterMs])
      assert.equal(calls, 2)
    } else {
      await assert.rejects(operation, /status query failed/)
      assert.deepEqual(pauses, [])
      assert.equal(calls, 1)
    }
  }
})

test('command failures do not expose private arguments or captured tool output', async () => {
  const secret = 'fixture-private-password'
  await assert.rejects(apple(process.execPath, ['-e', 'console.error(process.argv[1]); process.exit(1)', secret]), error => {
    assert.match(error.message, /failed/)
    assert.ok(!error.message.includes(secret))
    return true
  })
})

test('classifies known transport failures without retaining private tool diagnostics', async () => {
  for (const [diagnostic, retryable] of [['NSURLErrorDomain Code=-1005 The network connection was lost.', true], ['HTTP status code: 503', true], ['HTTP status code: 401', false], ['HTTP status code: 429\nRetry-After: 7', true]]) {
    await assert.rejects(apple(process.execPath, ['-e', 'console.error(process.argv[1]); process.exit(1)', `fixture-private-output\n${diagnostic}`]), error => {
      assert.equal(error.retryable, retryable)
      if (diagnostic.includes('Retry-After')) assert.equal(error.retryAfterMs, 7000)
      assert.ok(!error.message.includes(diagnostic) && !JSON.stringify(error).includes('fixture-private-output'))
      return true
    })
  }
})
