/** Create a verified installer from the signed app without mounting a writable disk image. */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('macOS installer requires a macOS builder')
const run = promisify(execFile)
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.env.RELEASE_TARGET
if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target)) throw new Error('exact macOS target is required')
const configuration = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'))
const bundle = join(desktop, '.desktop-build/tauri/target', target, 'release/bundle')
const app = join(bundle, 'macos', `${configuration.productName}.app`)
await run('codesign', ['--verify', '--deep', '--strict', app])
await mkdir(join(bundle, 'dmg'), { recursive: true })
const staging = await mkdtemp(join(bundle, 'installer-'))
const suffix = target.startsWith('aarch64') ? 'aarch64' : 'x64'
const destination = join(bundle, 'dmg', `${configuration.productName}_${configuration.version}_${suffix}.dmg`)
try {
  await run('ditto', [app, join(staging, `${configuration.productName}.app`)])
  await symlink('/Applications', join(staging, 'Applications'))
  await run('hdiutil', ['create', '-ov', '-format', 'UDZO', '-volname', configuration.productName, '-srcfolder', staging, destination])
  await run('hdiutil', ['verify', destination])
  console.log(`Verboo Code: verified macOS installer ${destination}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
