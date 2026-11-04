/** Build the shared artifacts and launch the Tauri development application. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareRuntime } from './prepare-runtime.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(desktop, '../..')
const output = join(desktop, '.desktop-build/tauri')
const [mode = 'dev', ...args] = process.argv.slice(2)
if (!['dev', 'start', 'build', 'native-build', 'prepare'].includes(mode)) throw new Error('tauri: unsupported launcher mode')
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
