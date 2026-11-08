/** Verify all platform artifacts before creating any public release or tag. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configuration = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'))
const source = process.env.GITHUB_SHA
if (!/^[a-f0-9]{40}$/.test(source ?? '')) throw new Error('exact source SHA is required')
const directory = resolve(process.argv[2])
const platforms = {
  'macOS-Apple-Silicon': ['aarch64-apple-darwin', ['dmg'], 'darwin-aarch64', '-macOS-Apple-Silicon.app.tar.gz'],
  'macOS-Intel': ['x86_64-apple-darwin', ['dmg'], 'darwin-x86_64', '-macOS-Intel.app.tar.gz'],
  'Windows-x64': ['x86_64-pc-windows-msvc', ['exe'], 'windows-x86_64', '-Windows-x64-Setup.exe'],
  'Linux-x64': ['x86_64-unknown-linux-gnu', ['AppImage', 'deb', 'rpm'], 'linux-x86_64', '-Linux-x64.AppImage'],
}
const allowed = new Set(['SHA256SUMS', 'RELEASE.md'])
const checksums = []
const feed = { version: configuration.version, pub_date: new Date().toISOString(), platforms: {} }
for (const [label, [target, extensions, updaterTarget, updaterSuffix]] of Object.entries(platforms)) {
  const manifest = `manifest-${label}.json`
  allowed.add(manifest)
  const data = JSON.parse(await readFile(join(directory, manifest), 'utf8'))
  if (data.version !== 1 || data.source !== source || data.productVersion !== configuration.version || data.label !== label || data.target !== target || !Array.isArray(data.installers) || data.installers.length !== extensions.length) {
    throw new Error(`release identity mismatch: ${label}`)
  }
  for (const extension of extensions) {
    const name = `Verboo-Code-v2-${configuration.version}-${label}${extension === 'exe' ? '-Setup' : ''}.${extension}`
    allowed.add(name)
    const entry = data.installers.find(installer => installer.name === name)
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`missing installer digest: ${label}`)
    const path = join(directory, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size === 0 || stat.size !== entry.bytes) throw new Error(`invalid installer file: ${label}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest('hex') !== entry.sha256) throw new Error(`installer digest mismatch: ${label}`)
    checksums.push(`${entry.sha256}  ${name}`)
  }
  if (!Array.isArray(data.updaters) || data.updaters.length !== 1) throw new Error(`missing updater bundle: ${label}`)
  const updater = data.updaters[0]
  if (updater.name !== `Verboo-Code-v2-${configuration.version}${updaterSuffix}`) throw new Error(`unexpected updater name: ${label}`)
  if (!/^[A-Za-z0-9+/=\s]+$/.test(updater.signature ?? '')) throw new Error(`missing updater signature: ${label}`)
  allowed.add(updater.name)
  const updaterPath = join(directory, updater.name)
  const updaterStat = await lstat(updaterPath)
  if (!updaterStat.isFile() || updaterStat.size === 0 || updaterStat.size !== updater.bytes) throw new Error(`invalid updater file: ${label}`)
  const updaterHash = createHash('sha256')
  for await (const chunk of createReadStream(updaterPath)) updaterHash.update(chunk)
  if (updaterHash.digest('hex') !== updater.sha256) throw new Error(`updater digest mismatch: ${label}`)
  feed.platforms[updaterTarget] = {
    signature: updater.signature,
    url: `https://github.com/verbeux-ai/verboo-code-v2/releases/download/v${configuration.version}/${updater.name}`,
  }
}
if (Object.keys(feed.platforms).length !== Object.keys(platforms).length) throw new Error('incomplete update feed')
for (const name of await readdir(directory)) if (!allowed.has(name)) throw new Error('unexpected release artifact')
await writeFile(join(directory, 'SHA256SUMS'), checksums.sort().join('\n') + '\n')
await writeFile(join(directory, 'RELEASE.md'), `Verboo Code v2 ${configuration.version}\n\nSource: ${source}\n\nDesktop installers for macOS ${configuration.bundle.macOS.minimumSystemVersion}+ (Apple Silicon and Intel), Windows x64 and Linux x64. The desktop includes its own agent runtime.\n\nStamina is visible only for accounts explicitly selected by an administrator after the feature is enabled.\n\nThis initial alpha has unsigned Windows installers and ad-hoc signed macOS installers without Apple notarization.\n\nVerify installer integrity using SHA256SUMS.\n`)
// The feed is a published index rather than a release asset, so it stays out of
// the verified directory: publication regenerates it from the same manifests.
const feedPath = process.env.VERBOO_UPDATE_FEED_PATH ?? join(dirname(directory), 'update-feed', 'latest.json')
await mkdir(dirname(feedPath), { recursive: true })
await writeFile(feedPath, JSON.stringify(feed, null, 2) + '\n')
console.log(JSON.stringify({ verified: true, source, installers: checksums.length, feed: feedPath }))
