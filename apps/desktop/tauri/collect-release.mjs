/** Collect the native installer's exact bytes and source identity for release verification. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configuration = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'))
const { RELEASE_LABEL: label, RELEASE_TARGET: target, GITHUB_SHA: source } = process.env
const platforms = {
  'macOS-Apple-Silicon': ['dmg'],
  'macOS-Intel': ['dmg'],
  'Windows-x64': ['exe'],
  'Linux-x64': ['AppImage', 'deb', 'rpm'],
}

/**
 * Updater bundles and target names Tauri uses when choosing a package.
 *
 * Tauri reuses the installer on Linux and Windows, where an update replaces the
 * same bytes, and archives the application bundle on macOS, where the installer
 * is a disk image the updater cannot swap in place.
 */
const updaterBundles = {
  'macOS-Apple-Silicon': [{ directory: 'macos', suffix: '.app.tar.gz', publishedSuffix: '-macOS-Apple-Silicon.app.tar.gz', target: 'darwin-aarch64-app' }],
  'macOS-Intel': [{ directory: 'macos', suffix: '.app.tar.gz', publishedSuffix: '-macOS-Intel.app.tar.gz', target: 'darwin-x86_64-app' }],
  'Windows-x64': [{ directory: 'nsis', suffix: '.exe', publishedSuffix: '-Windows-x64-Setup.exe', target: 'windows-x86_64-nsis' }],
  'Linux-x64': [
    { directory: 'appimage', suffix: '.AppImage', publishedSuffix: '-Linux-x64.AppImage', target: 'linux-x86_64-appimage' },
    { directory: 'deb', suffix: '.deb', publishedSuffix: '-Linux-x64.deb', target: 'linux-x86_64-deb' },
    { directory: 'rpm', suffix: '.rpm', publishedSuffix: '-Linux-x64.rpm', target: 'linux-x86_64-rpm' },
  ],
}

if (!(label in platforms) || !/^[a-z0-9_-]+$/.test(target ?? '') || !/^[a-f0-9]{40}$/.test(source ?? '')) {
  throw new Error('release platform and exact source SHA are required')
}
// The release lifecycle test stages a bundle tree of its own; a real build uses
// the packaging output next to the checked-out source.
const output = process.env.VERBOO_RELEASE_ASSETS ?? join(desktop, '.desktop-build/tauri/release-assets')
const bundles = process.env.VERBOO_RELEASE_BUNDLES
  ? join(process.env.VERBOO_RELEASE_BUNDLES, target, 'release/bundle')
  : join(desktop, '.desktop-build/tauri/target', target, 'release/bundle')
const directories = { dmg: 'dmg', exe: 'nsis', AppImage: 'appimage', deb: 'deb', rpm: 'rpm' }
const entries = []
const updaters = []

/**
 * Copy one bundle file under its published name.
 * @param path - the bundle file to copy.
 * @param name - the published file name.
 * @returns Its published name, byte count and SHA-256.
 */
async function collect(path, name) {
  const destination = join(output, name)
  await copyFile(path, destination)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(destination)) { hash.update(chunk); bytes += chunk.length }
  if (bytes === 0) throw new Error('empty installer')
  return { name, bytes, sha256: hash.digest('hex') }
}

/**
 * Find the single file in a bundle directory ending with a suffix.
 * @param directory - the bundle directory to read.
 * @param suffix - the file name suffix that selects the artifact.
 * @returns The matching file name.
 */
async function only(directory, suffix) {
  const matches = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
  if (matches.length !== 1) throw new Error(`expected exactly one ${suffix} in ${directory}`)
  return matches[0].name
}

await mkdir(output, { recursive: true })
for (const extension of platforms[label]) {
  const directory = join(bundles, directories[extension])
  const name = `Verboo-Code-v2-${configuration.version}-${label}${extension === 'exe' ? '-Setup' : ''}.${extension}`
  entries.push(await collect(join(directory, await only(directory, `.${extension}`)), name))
}

for (const { directory, suffix, publishedSuffix, target: updaterTarget } of updaterBundles[label]) {
  const updaterRoot = join(bundles, directory)
  const bundle = await only(updaterRoot, suffix)
  if (!(await readdir(updaterRoot)).includes(`${bundle}.sig`)) throw new Error(`missing updater signature for ${label} (${updaterTarget})`)
  const updaterName = `Verboo-Code-v2-${configuration.version}${publishedSuffix}`
  updaters.push({
    ...(await collect(join(updaterRoot, bundle), updaterName)),
    target: updaterTarget,
    signature: (await readFile(join(updaterRoot, `${bundle}.sig`), 'utf8')).trim(),
  })
}

await writeFile(join(output, `manifest-${label}.json`), JSON.stringify({ version: 1, source, productVersion: configuration.version, label, target, installers: entries, updaters }, null, 2) + '\n')
