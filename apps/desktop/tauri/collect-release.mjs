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
if (!(label in platforms) || !/^[a-z0-9_-]+$/.test(target ?? '') || !/^[a-f0-9]{40}$/.test(source ?? '')) {
  throw new Error('release platform and exact source SHA are required')
}
const output = join(desktop, '.desktop-build/tauri/release-assets')
const bundles = join(desktop, '.desktop-build/tauri/target', target, 'release/bundle')
const directories = { dmg: 'dmg', exe: 'nsis', AppImage: 'appimage', deb: 'deb', rpm: 'rpm' }
const entries = []
await mkdir(output, { recursive: true })
for (const extension of platforms[label]) {
  const directory = join(bundles, directories[extension])
  const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(`.${extension}`))
  if (files.length !== 1) throw new Error(`expected exactly one ${extension} installer`)
  const name = `Verboo-Code-v2-${configuration.version}-${label}${extension === 'exe' ? '-Setup' : ''}.${extension}`
  const destination = join(output, name)
  await copyFile(join(directory, files[0].name), destination)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(destination)) { hash.update(chunk); bytes += chunk.length }
  if (bytes === 0) throw new Error('empty installer')
  entries.push({ name, bytes, sha256: hash.digest('hex') })
}
await writeFile(join(output, `manifest-${label}.json`), JSON.stringify({ version: 1, source, productVersion: configuration.version, label, target, installers: entries }, null, 2) + '\n')
