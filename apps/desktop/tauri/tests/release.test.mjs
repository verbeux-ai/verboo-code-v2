import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
  'macOS-Apple-Silicon': ['aarch64-apple-darwin', ['dmg']],
  'macOS-Intel': ['x86_64-apple-darwin', ['dmg']],
  'Windows-x64': ['x86_64-pc-windows-msvc', ['exe']],
  'Linux-x64': ['x86_64-unknown-linux-gnu', ['AppImage', 'deb', 'rpm']],
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'verboo-release-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [label, [target, extensions]] of Object.entries(platforms)) {
    const installers = []
    for (const extension of extensions) {
      const name = `Verboo-Code-v2-${configuration.version}-${label}${extension === 'exe' ? '-Setup' : ''}.${extension}`
      const bytes = Buffer.from(`installer:${label}:${extension}`)
      await writeFile(join(directory, name), bytes)
      installers.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    await writeFile(join(directory, `manifest-${label}.json`), JSON.stringify({ version: 1, source, productVersion: configuration.version, label, target, installers }))
  }
  return { directory, verify: () => run(process.execPath, [join(desktop, 'tauri/verify-release.mjs'), directory], { env: { ...process.env, GITHUB_SHA: source } }) }
}

test('publishes checksums only for the complete exact-source installer set', async t => {
  const f = await fixture(t)
  const result = await f.verify()
  assert.equal(JSON.parse(result.stdout).installers, 6)
  assert.equal((await readFile(join(f.directory, 'SHA256SUMS'), 'utf8')).trim().split('\n').length, 6)
  assert.match(await readFile(join(f.directory, 'RELEASE.md'), 'utf8'), new RegExp(source))
})

for (const failure of ['missing platform', 'tampered installer', 'wrong source', 'unexpected artifact']) {
  test(`rejects ${failure} before publishing checksums`, async t => {
    const f = await fixture(t)
    const manifest = join(f.directory, 'manifest-macOS-Intel.json')
    const data = JSON.parse(await readFile(manifest, 'utf8'))
    if (failure === 'missing platform') await rm(manifest)
    if (failure === 'tampered installer') await writeFile(join(f.directory, data.installers[0].name), 'corrupted')
    if (failure === 'wrong source') { data.source = 'b'.repeat(40); await writeFile(manifest, JSON.stringify(data)) }
    if (failure === 'unexpected artifact') await writeFile(join(f.directory, 'unrelated.tgz'), 'unrelated')
    await assert.rejects(f.verify())
    await assert.rejects(readFile(join(f.directory, 'SHA256SUMS')), { code: 'ENOENT' })
  })
}

test('confirms uploaded bytes before making the draft public', async t => {
  const f = await fixture(t)
  await f.verify()
  const directory = await mkdtemp(join(tmpdir(), 'verboo-upload-metadata-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const metadata = join(directory, 'release.json')
  const assets = []
  for (const name of await readdir(f.directory)) {
    const bytes = await readFile(join(f.directory, name))
    assets.push({ name, state: 'uploaded', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })
  }
  const release = { draft: true, target_commitish: source, assets }
  const verify = () => run(process.execPath, [join(desktop, 'tauri/verify-uploaded-release.mjs'), f.directory, metadata], { env: { ...process.env, GITHUB_SHA: source } })
  await writeFile(metadata, JSON.stringify(release))
  assert.equal(JSON.parse((await verify()).stdout).uploaded, 12)
  assets[0].digest = `sha256:${'0'.repeat(64)}`
  await writeFile(metadata, JSON.stringify(release))
  await assert.rejects(verify())
})
