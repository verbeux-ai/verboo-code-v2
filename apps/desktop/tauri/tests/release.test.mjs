import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const configuration = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'))
const source = 'a'.repeat(40)
const run = promisify(execFile)
const platforms = {
  'macOS-Apple-Silicon': {
    target: 'aarch64-apple-darwin', extensions: ['dmg'],
    updaters: [{ target: 'darwin-aarch64-app', suffix: '-macOS-Apple-Silicon.app.tar.gz' }],
  },
  'macOS-Intel': {
    target: 'x86_64-apple-darwin', extensions: ['dmg'],
    updaters: [{ target: 'darwin-x86_64-app', suffix: '-macOS-Intel.app.tar.gz' }],
  },
  'Windows-x64': {
    target: 'x86_64-pc-windows-msvc', extensions: ['exe'],
    updaters: [{ target: 'windows-x86_64-nsis', suffix: '-Windows-x64-Setup.exe' }],
  },
  'Linux-x64': {
    target: 'x86_64-unknown-linux-gnu', extensions: ['AppImage', 'deb', 'rpm'],
    updaters: [
      { target: 'linux-x86_64-appimage', suffix: '-Linux-x64.AppImage' },
      { target: 'linux-x86_64-deb', suffix: '-Linux-x64.deb' },
      { target: 'linux-x86_64-rpm', suffix: '-Linux-x64.rpm' },
    ],
  },
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'verboo-release-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [label, platform] of Object.entries(platforms)) {
    const { target, extensions, updaters: updaterSpecs } = platform
    const installers = []
    for (const extension of extensions) {
      const name = `Verboo-Code-v2-${configuration.version}-${label}${extension === 'exe' ? '-Setup' : ''}.${extension}`
      const bytes = Buffer.from(`installer:${label}:${extension}`)
      await writeFile(join(directory, name), bytes)
      installers.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    const updaters = []
    for (const spec of updaterSpecs) {
      const name = `Verboo-Code-v2-${configuration.version}${spec.suffix}`
      const reused = installers.find(installer => installer.name === name)
      const installerExtension = name.endsWith('.AppImage') ? 'AppImage' : name.split('.').at(-1)
      const updaterBytes = reused ? Buffer.from(`installer:${label}:${installerExtension}`) : Buffer.from(`updater:${label}:${spec.target}`)
      if (!reused) await writeFile(join(directory, name), updaterBytes)
      updaters.push({
        target: spec.target,
        name,
        bytes: updaterBytes.length,
        sha256: createHash('sha256').update(updaterBytes).digest('hex'),
        signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=',
      })
    }
    await writeFile(join(directory, `manifest-${label}.json`), JSON.stringify({ version: 1, source, productVersion: configuration.version, label, target, installers, updaters }))
  }
  const feed = join(directory, '..', `feed-${randomUUID()}.json`)
  return { directory, feed, verify: () => run(process.execPath, [join(desktop, 'tauri/verify-release.mjs'), directory], { env: { ...process.env, GITHUB_SHA: source, VERBOO_UPDATE_FEED_PATH: feed } }) }
}

test('publishes checksums only for the complete exact-source installer set', async t => {
  const f = await fixture(t)
  const result = await f.verify()
  assert.equal(JSON.parse(result.stdout).installers, 6)
  assert.equal((await readFile(join(f.directory, 'SHA256SUMS'), 'utf8')).trim().split('\n').length, 6)
  assert.match(await readFile(join(f.directory, 'RELEASE.md'), 'utf8'), new RegExp(source))
  const feed = JSON.parse(await readFile(f.feed, 'utf8'))
  assert.deepEqual(Object.keys(feed.platforms).sort(), [
    'darwin-aarch64', 'darwin-aarch64-app', 'darwin-x86_64', 'darwin-x86_64-app',
    'linux-x86_64', 'linux-x86_64-appimage', 'linux-x86_64-deb', 'linux-x86_64-rpm',
    'windows-x86_64', 'windows-x86_64-nsis',
  ])
  assert.match(feed.platforms['linux-x86_64-deb'].url, /Linux-x64\.deb$/)
  assert.match(feed.platforms['linux-x86_64-rpm'].url, /Linux-x64\.rpm$/)
  assert.match(feed.platforms['linux-x86_64'].url, /Linux-x64\.AppImage$/)
})

for (const failure of ['missing platform', 'tampered installer', 'wrong source', 'unexpected artifact', 'missing updater', 'unsigned updater', 'tampered updater']) {
  test(`rejects ${failure} before publishing checksums`, async t => {
    const f = await fixture(t)
    const manifest = join(f.directory, 'manifest-macOS-Intel.json')
    const data = JSON.parse(await readFile(manifest, 'utf8'))
    if (failure === 'missing platform') await rm(manifest)
    if (failure === 'tampered installer') await writeFile(join(f.directory, data.installers[0].name), 'corrupted')
    if (failure === 'wrong source') { data.source = 'b'.repeat(40); await writeFile(manifest, JSON.stringify(data)) }
    if (failure === 'unexpected artifact') await writeFile(join(f.directory, 'unrelated.tgz'), 'unrelated')
    if (failure === 'missing updater') { data.updaters = []; await writeFile(manifest, JSON.stringify(data)) }
    if (failure === 'unsigned updater') { data.updaters[0].signature = ''; await writeFile(manifest, JSON.stringify(data)) }
    if (failure === 'tampered updater') await writeFile(join(f.directory, data.updaters[0].name), 'corrupted')
    await assert.rejects(f.verify())
    await assert.rejects(readFile(join(f.directory, 'SHA256SUMS')), { code: 'ENOENT' })
  })
}
