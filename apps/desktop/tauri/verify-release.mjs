/** Verify all platform artifacts before creating any public release or tag. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configuration = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'))
const source = process.env.GITHUB_SHA
if (!/^[a-f0-9]{40}$/.test(source ?? '')) throw new Error('exact source SHA is required')
const directory = resolve(process.argv[2])
const platforms = {
  'macOS-Apple-Silicon': ['aarch64-apple-darwin', ['dmg']],
  'macOS-Intel': ['x86_64-apple-darwin', ['dmg']],
  'Windows-x64': ['x86_64-pc-windows-msvc', ['exe']],
  'Linux-x64': ['x86_64-unknown-linux-gnu', ['AppImage', 'deb', 'rpm']],
}
const allowed = new Set(['SHA256SUMS', 'RELEASE.md'])
const checksums = []
for (const [label, [target, extensions]] of Object.entries(platforms)) {
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
}
for (const name of await readdir(directory)) if (!allowed.has(name)) throw new Error('unexpected release artifact')
await writeFile(join(directory, 'SHA256SUMS'), checksums.sort().join('\n') + '\n')
await writeFile(join(directory, 'RELEASE.md'), `Verboo Code v2 ${configuration.version}\n\nSource: ${source}\n\nDesktop installers for macOS (Apple Silicon and Intel), Windows x64 and Linux x64. The desktop includes its own agent runtime.\n\nStamina is visible only for accounts explicitly selected by an administrator after the feature is enabled.\n\nThis initial alpha has unsigned Windows installers and ad-hoc signed macOS installers without Apple notarization.\n\nVerify installer integrity using SHA256SUMS.\n`)
console.log(JSON.stringify({ verified: true, source, installers: checksums.length }))
