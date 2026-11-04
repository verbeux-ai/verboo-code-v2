/** Create a verified installer from the signed app without mounting a writable disk image. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createDiskImage } from './create-dmg.mjs'

if (process.platform !== 'darwin') throw new Error('macOS installer requires a macOS builder')
const run = promisify(execFile)
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.env.RELEASE_TARGET
if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target)) throw new Error('exact macOS target is required')
const configuration = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'))
const bundle = join(desktop, '.desktop-build/tauri/target', target, 'release/bundle')
const app = join(bundle, 'macos', `${configuration.productName}.app`)
await run('codesign', ['--verify', '--deep', '--strict', app], { timeout: 300_000 })
const suffix = target.startsWith('aarch64') ? 'aarch64' : 'x64'
const destination = join(bundle, 'dmg', `${configuration.productName}_${configuration.version}_${suffix}.dmg`)
await createDiskImage({ application: app, destination, name: configuration.productName })
console.log(`Verboo Code: verified macOS installer ${destination}`)
