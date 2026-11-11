/** Build the shared artifacts and launch the Tauri development application. */
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareRuntime } from './prepare-runtime.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(desktop, '../..')
const output = join(desktop, '.desktop-build/tauri')
const [mode = 'dev', ...args] = process.argv.slice(2)
if (!['dev', 'start', 'build', 'native-build', 'prepare'].includes(mode)) throw new Error('tauri: unsupported launcher mode')
const extensionId = process.env.VERBOO_CHROME_EXTENSION_ID
if (mode === 'build' && (typeof extensionId !== 'string' || !/^[a-p]{32}$/u.test(extensionId))) {
  throw new Error('tauri: set VERBOO_CHROME_EXTENSION_ID to the published Chrome extension ID before building a release')
}
const packageManager = process.env.npm_execpath
if (!packageManager) throw new Error('tauri: invoke through pnpm run dev:desktop or start:desktop')

/** Run the same pnpm distribution as the parent and preserve nonzero child exits. */
async function pnpm(args, cwd = repository, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [packageManager, ...args], { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`tauri: child exited ${code ?? signal}`)))
  })
}

mkdirSync(join(output, 'runtime'), { recursive: true })
// Resource paths must exist for the initial Rust build, before the production runtime is prepared.
const runtimePlaceholder = join(output, 'runtime/.gitkeep')
if (!existsSync(runtimePlaceholder)) writeFileSync(runtimePlaceholder, '')

/** Build the standalone Chrome Native Messaging executable for this desktop target. */
async function buildBrowserNativeHost(release, targetTriple) {
  const target = join(output, 'cargo')
  const profile = release ? 'release' : 'debug'
  const windowsTarget = targetTriple === undefined
    ? process.platform === 'win32'
    : targetTriple.includes('-windows-')
  const executable = windowsTarget ? 'verboo-browser-native-host.exe' : 'verboo-browser-native-host'
  const packaged = join(output, 'native-host', executable)
  mkdirSync(dirname(packaged), { recursive: true })
  const buildFor = async triple => {
    const args = [
      'build', '--locked', '--manifest-path', 'src-tauri/native-host/Cargo.toml', '--target-dir', target,
      ...(triple === undefined ? [] : ['--target', triple]),
      ...(release ? ['--release'] : []),
    ]
    await new Promise((resolve, reject) => {
      const child = spawn('cargo', args, { cwd: desktop, env: process.env, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`browser native host build exited ${code}`)))
    })
    return join(target, ...(triple === undefined ? [] : [triple]), profile, executable)
  }

  if (targetTriple === 'universal-apple-darwin') {
    if (process.platform !== 'darwin') throw new Error('universal macOS browser host builds must run on macOS')
    const architectures = ['aarch64-apple-darwin', 'x86_64-apple-darwin']
    const binaries = []
    for (const triple of architectures) binaries.push(await buildFor(triple))
    await new Promise((resolve, reject) => {
      const child = spawn('lipo', ['-create', ...binaries, '-output', packaged], { cwd: desktop, env: process.env, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`browser native host universal merge exited ${code}`)))
    })
  } else {
    copyFileSync(await buildFor(targetTriple), packaged)
  }
  if (process.platform !== 'win32') chmodSync(packaged, 0o755)
  return packaged
}

const targetArgument = args.findIndex(argument => argument === '--target' || argument === '-t')
const targetOption = args.find(argument => argument.startsWith('--target=') || argument.startsWith('-t='))
const targetTriple = targetArgument >= 0
  ? args[targetArgument + 1]
  : targetOption?.slice(targetOption.indexOf('=') + 1) ?? process.env.TAURI_ENV_TARGET_TRIPLE
const nativeHostBinary = ['dev', 'start', 'build', 'native-build'].includes(mode)
  ? await buildBrowserNativeHost(mode === 'build', targetTriple)
  : undefined
if (mode === 'native-build') {
  await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml'], { cwd: desktop, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`native build exited ${code}`)))
  })
  process.exit(0)
}
if (mode === 'prepare') process.exit(0)
if ((mode === 'dev' || mode === 'build') && !args.includes('--skip-build')) await pnpm(['run', 'build:artifacts'])
const cliManifest = join(repository, 'apps/cli/package.json')
if (!existsSync(join(repository, 'apps/cli/lib/profile-boot.js')) || !existsSync(join(repository, 'apps/web/dist/index.html'))) {
  throw new Error('tauri: run pnpm run build:artifacts before starting the desktop')
}
const manifest = join(output, 'development.json')
writeFileSync(manifest, JSON.stringify({
  node: process.execPath,
  host: join(desktop, 'tauri/host.mjs'),
  cliManifest,
  workingDirectory: repository,
  home: join(output, 'home'),
}, null, 2) + '\n')
const env = { ...process.env, VERBOO_TAURI_RUNTIME_CONFIG: manifest }
if (nativeHostBinary !== undefined && mode !== 'build') env.VERBOO_BROWSER_NATIVE_HOST = nativeHostBinary
if (mode === 'build') {
  await prepareRuntime({ repository, desktop, output, packageManager })
  const releaseEnvironment = { ...process.env }
  delete releaseEnvironment.VERBOO_TAURI_RUNTIME_CONFIG
  await pnpm(['--filter', '@deepseek-ai/dsh-desktop', 'exec', 'tauri', 'build', ...args.filter(arg => arg !== '--skip-build')], repository, releaseEnvironment)
  process.exit(0)
}
let watcher
let native
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  for (const child of [watcher, native]) {
    if (child?.pid === undefined) continue
    try {
      if (process.platform === 'win32') child.kill('SIGTERM')
      else process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      // The leader may already have exited after stopping its descendants.
      if (error.code !== 'ESRCH') { console.error('Verboo Code: child_shutdown_failed'); process.exitCode = 1 }
    }
  }
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  if (mode === 'dev') {
    watcher = spawn(process.execPath, [packageManager, 'run', 'dev:web', '--skip-build', '--no-serve'], {
      cwd: repository, env, stdio: 'inherit', detached: process.platform !== 'win32',
    })
    watcher.once('error', (error) => { console.error(error); process.exitCode = 1; stop() })
    watcher.once('exit', () => {
      if (!stopping) { console.error('Verboo Code: client watcher stopped'); process.exitCode = 1; stop() }
    })
  }
  await new Promise((resolve, reject) => {
    native = spawn(process.execPath, [packageManager, '--filter', '@deepseek-ai/dsh-desktop', 'exec', 'tauri', 'dev',
      ...args.filter(arg => arg !== '--skip-build' && arg !== '--')], {
      cwd: repository, env, stdio: 'inherit', detached: process.platform !== 'win32',
    })
    native.once('error', reject)
    native.once('exit', (code, signal) => code === 0 || stopping ? resolve() : reject(new Error(`Tauri exited ${code ?? signal}`)))
  })
} finally {
  stop()
}
