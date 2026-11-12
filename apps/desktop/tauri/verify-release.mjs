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
  'macOS-Apple-Silicon': {
    target: 'aarch64-apple-darwin', extensions: ['dmg'],
    updaters: [{ target: 'darwin-aarch64-app', alias: 'darwin-aarch64', suffix: '-macOS-Apple-Silicon.app.tar.gz' }],
  },
  'macOS-Intel': {
    target: 'x86_64-apple-darwin', extensions: ['dmg'],
    updaters: [{ target: 'darwin-x86_64-app', alias: 'darwin-x86_64', suffix: '-macOS-Intel.app.tar.gz' }],
  },
  'Windows-x64': {
    target: 'x86_64-pc-windows-msvc', extensions: ['exe'],
    updaters: [{ target: 'windows-x86_64-nsis', alias: 'windows-x86_64', suffix: '-Windows-x64-Setup.exe' }],
  },
  'Linux-x64': {
    target: 'x86_64-unknown-linux-gnu', extensions: ['AppImage', 'deb', 'rpm'],
    updaters: [
      { target: 'linux-x86_64-appimage', alias: 'linux-x86_64', suffix: '-Linux-x64.AppImage' },
      { target: 'linux-x86_64-deb', suffix: '-Linux-x64.deb' },
      { target: 'linux-x86_64-rpm', suffix: '-Linux-x64.rpm' },
    ],
  },
}
const omitAppleSilicon = process.env.VERBOO_RELEASE_OMIT_MACOS_ARM64 === 'true'
if (process.env.VERBOO_RELEASE_OMIT_MACOS_ARM64 !== undefined && !['true', 'false'].includes(process.env.VERBOO_RELEASE_OMIT_MACOS_ARM64)) {
  throw new Error('invalid Apple Silicon release omission setting')
}
if (omitAppleSilicon) delete platforms['macOS-Apple-Silicon']
const allowed = new Set(['SHA256SUMS', 'RELEASE.md'])
const checksums = []
const feed = { version: configuration.version, pub_date: new Date().toISOString(), platforms: {} }
for (const [label, platform] of Object.entries(platforms)) {
  const { target, extensions, updaters: expectedUpdaters } = platform
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
  if (!Array.isArray(data.updaters) || data.updaters.length !== expectedUpdaters.length) throw new Error(`missing updater bundle: ${label}`)
  for (const expected of expectedUpdaters) {
    const updater = data.updaters.find(entry => entry.target === expected.target)
    if (!updater || updater.name !== `Verboo-Code-v2-${configuration.version}${expected.suffix}`) throw new Error(`unexpected updater bundle: ${label} (${expected.target})`)
    if (!/^[A-Za-z0-9+/=\s]+$/.test(updater.signature ?? '')) throw new Error(`missing updater signature: ${label} (${expected.target})`)
    allowed.add(updater.name)
    const updaterPath = join(directory, updater.name)
    const updaterStat = await lstat(updaterPath)
    if (!updaterStat.isFile() || updaterStat.size === 0 || updaterStat.size !== updater.bytes) throw new Error(`invalid updater file: ${label} (${expected.target})`)
    const updaterHash = createHash('sha256')
    for await (const chunk of createReadStream(updaterPath)) updaterHash.update(chunk)
    if (updaterHash.digest('hex') !== updater.sha256) throw new Error(`updater digest mismatch: ${label} (${expected.target})`)
    const platform = {
      signature: updater.signature,
      url: `https://github.com/verbeux-ai/verboo-code-v2/releases/download/v${configuration.version}/${updater.name}`,
    }
    feed.platforms[expected.target] = platform
    if (expected.alias) feed.platforms[expected.alias] = platform
  }
}
if (Object.keys(feed.platforms).length !== (omitAppleSilicon ? 8 : 10)) throw new Error('incomplete update feed')
for (const name of await readdir(directory)) if (!allowed.has(name)) throw new Error('unexpected release artifact')
await writeFile(join(directory, 'SHA256SUMS'), checksums.sort().join('\n') + '\n')
const availablePlatforms = omitAppleSilicon
  ? 'macOS Intel, Windows x64 e Linux x64'
  : 'macOS Apple Silicon e Intel, Windows x64 e Linux x64'
const platformNote = omitAppleSilicon
  ? '\n\nEsta versão não inclui Apple Silicon; usuários Mac ARM não receberão a atualização até uma próxima versão.'
  : ''
const releaseNotes = 'Verboo Code v2 ' + configuration.version + '\n\n- Até quatro chats simultâneos, com painéis redimensionáveis.\n- Troca de conversa pelo cabeçalho e indicação do painel selecionado.\n- Esc interrompe a resposta do chat selecionado.\n- Setas para cima e para baixo percorrem o histórico de mensagens enviadas.\n- Leitura de Stamina compartilhada entre os chats da mesma conta.\n\nInstaladores para ' + availablePlatforms + '.\n' + platformNote + '\n\nO instalador Windows não é assinado; o macOS usa assinatura ad hoc, sem notarização da Apple. Confira a integridade em SHA256SUMS.\n\nSource: ' + source + '\n'
await writeFile(join(directory, 'RELEASE.md'), releaseNotes)
// The feed is a published index rather than a release asset, so it stays out of
// the verified directory: publication regenerates it from the same manifests.
const feedPath = process.env.VERBOO_UPDATE_FEED_PATH ?? join(dirname(directory), 'update-feed', 'latest.json')
await mkdir(dirname(feedPath), { recursive: true })
await writeFile(feedPath, JSON.stringify(feed, null, 2) + '\n')
console.log(JSON.stringify({ verified: true, source, installers: checksums.length, feed: feedPath }))
