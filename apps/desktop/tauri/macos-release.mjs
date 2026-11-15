/** Own Apple credentials and the temporary keychain for one complete native macOS release. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withMacOSSigningKeychain } from '../scripts/macos-signing-keychain.mjs'
import { apple, validateAppleCredentials, verifyApplication } from './macos-signing.mjs'

const expected = validateAppleCredentials(process.env)
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--check') {
  console.log('Verboo Code: Apple signing and notarization secrets are configured')
} else {
  const target = args[0] === '--target' && args.length === 2 ? args[1] : undefined
  const architecture = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x64' }[target]
  if (process.platform !== 'darwin' || !architecture || architecture !== process.arch) throw new Error('macOS release: --target must match the native macOS runner architecture')
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const repository = resolve(desktop, '../..')
  const manager = join(repository, 'node_modules/pnpm/bin/pnpm.cjs')
  const directory = await mkdtemp(join(tmpdir(), 'verboo-apple-release-'))
  try {
    const certificate = join(directory, 'developer-id.p12')
    const apiKey = join(directory, `AuthKey_${process.env.APPLE_API_KEY}.p8`)
    await writeFile(certificate, Buffer.from(process.env.APPLE_CERTIFICATE, 'base64'), { mode: 0o600, flag: 'wx' })
    await writeFile(apiKey, process.env.APPLE_API_PRIVATE_KEY, { mode: 0o600, flag: 'wx' })
    const environment = {
      ...process.env, CSC_LINK: certificate, CSC_KEY_PASSWORD: process.env.APPLE_CERTIFICATE_PASSWORD,
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: expected.signingIdentity,
      APPLE_API_KEY_PATH: apiKey, RELEASE_TARGET: target, VERBOO_REQUIRE_APPLE_SIGNING: 'true',
    }
    // Only the credential owner imports the certificate; Tauri uses this keychain's installed identity.
    for (const name of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_API_PRIVATE_KEY', 'APPLE_ID', 'APPLE_PASSWORD']) delete environment[name]
    await withMacOSSigningKeychain(environment, async signedEnvironment => {
      const config = JSON.stringify({ bundle: { macOS: { signingIdentity: signedEnvironment.APPLE_SIGNING_IDENTITY, hardenedRuntime: true } } })
      await apple(process.execPath, [manager, 'run', 'build:desktop', '--skip-build', '--verbose', '--target', target, '--bundles', 'app', '--config', config], {
        cwd: repository, env: signedEnvironment, timeout: 90 * 60_000, maxBuffer: 32 << 20, stream: true,
      })
      await apple(process.execPath, [join(desktop, 'tauri/package-macos.mjs')], { cwd: repository, env: signedEnvironment, timeout: 30 * 60_000, stream: true })
      // Validate and exercise the exact archive the updater will install, including its stapled app.
      const bundles = join(desktop, '.desktop-build/tauri/target', target, 'release/bundle/macos')
      const archives = (await readdir(bundles)).filter(name => name.endsWith('.app.tar.gz'))
      if (archives.length !== 1) throw new Error('macOS release: expected exactly one application update archive')
      await apple('/usr/bin/tar', ['-xzf', join(bundles, archives[0]), '-C', directory])
      const configuration = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'))
      const application = join(directory, `${configuration.productName}.app`)
      await verifyApplication(application, signedEnvironment)
      const runtime = join(application, 'Contents/Resources/runtime')
      await apple(join(runtime, 'node'), ['--test', join(desktop, 'tauri/tests/host.test.mjs')], {
        cwd: repository, env: { ...signedEnvironment,
          VERBOO_TEST_CLI_MANIFEST: join(runtime, 'application/node_modules/@deepseek-ai/dsh/package.json'),
          VERBOO_TEST_HOST_MODULE: join(runtime, 'host.mjs'),
        }, timeout: 300_000, stream: true,
      })
    })
    console.log(`Verboo Code: signed and notarized macOS installer and update archive verified (${target})`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
