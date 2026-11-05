/** Create and verify a macOS installer without mounting a writable disk image. */
import { constants } from 'node:fs'
import { cp, link, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join } from 'node:path'

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
    await cp(application, join(contents, basename(application)), { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true })
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
