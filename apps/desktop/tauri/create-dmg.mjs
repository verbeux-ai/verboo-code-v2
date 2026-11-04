/** Create and verify a macOS installer without mounting a writable disk image. */
import { constants } from 'node:fs'
import { cp, link, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)

/**
 * Stage the signed application and Applications link, then atomically publish a verified image.
 * @param options - Built application, new image path, volume name and optional cancellation signal.
 * @returns The verified image path; existing files are never replaced.
 */
export async function createDiskImage({ application, destination, name, signal }) {
  if (process.platform !== 'darwin') throw new Error('macOS disk images require a native macOS builder')
  if (!application.endsWith('.app') || !destination.endsWith('.dmg') || !(await lstat(application)).isDirectory()) throw new Error('Invalid macOS application or installer path')
  await lstat(join(application, 'Contents/Info.plist'))
  let exists = true
  try { await lstat(destination) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    exists = false
  }
  if (exists) throw Object.assign(new Error('macOS installer already exists'), { code: 'EEXIST' })
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(join(dirname(destination), '.verboo-dmg-'))
  try {
    const contents = join(staging, 'contents')
    await mkdir(contents)
    await cp(application, join(contents, basename(application)), { recursive: true, mode: constants.COPYFILE_FICLONE })
    await symlink('/Applications', join(contents, 'Applications'))
    const image = join(staging, 'installer.dmg')
    signal?.throwIfAborted()
    await run('hdiutil', ['create', '-srcfolder', contents, '-volname', name, '-format', 'UDZO', '-fs', 'HFS+', '-nospotlight', image], { timeout: 900_000, maxBuffer: 1 << 20, signal })
    await run('hdiutil', ['verify', image], { timeout: 300_000, maxBuffer: 1 << 20, signal })
    const file = await lstat(image)
    if (!file.isFile() || file.size === 0) throw new Error('macOS disk image is empty')
    signal?.throwIfAborted()
    // Linking is atomic and refuses a destination created by a concurrent build.
    await link(image, destination)
    return destination
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function main() {
  const target = process.env.RELEASE_TARGET
  if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target)) throw new Error('Native macOS release target is required')
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const configuration = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'))
  const bundle = join(desktop, '.desktop-build/tauri/target', target, 'release/bundle')
  const destination = join(bundle, 'dmg', `Verboo-Code-${configuration.version}-${target}.dmg`)
  await createDiskImage({ application: join(bundle, 'macos', `${configuration.productName}.app`), destination, name: configuration.productName })
  console.log(`Verboo Code: verified macOS installer ${basename(destination)}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'macOS packaging failed'); process.exitCode = 1 })
}
