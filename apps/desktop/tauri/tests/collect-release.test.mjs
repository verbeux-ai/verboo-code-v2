import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const configuration = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'))
const source = 'a'.repeat(40)
const run = promisify(execFile)
const signature = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo='

/** Bundle layouts as the Tauri bundler leaves them, with the file names it uses. */
const layouts = {
  'macOS-Apple-Silicon': {
    target: 'aarch64-apple-darwin',
    files: { dmg: ['Verboo Code_0.2.2-alpha.7_aarch64.dmg'], macos: ['Verboo Code.app.tar.gz'] },
  },
  'macOS-Intel': {
    target: 'x86_64-apple-darwin',
    files: { dmg: ['Verboo Code_0.2.2-alpha.7_x64.dmg'], macos: ['Verboo Code.app.tar.gz'] },
  },
  'Windows-x64': {
    target: 'x86_64-pc-windows-msvc',
    files: { nsis: ['Verboo Code_0.2.2-alpha.7_x64-setup.exe'] },
  },
  'Linux-x64': {
    target: 'x86_64-unknown-linux-gnu',
    files: {
      appimage: ['Verboo Code_0.2.2-alpha.7_amd64.AppImage'],
      deb: ['Verboo Code_0.2.2-alpha.7_amd64.deb'],
      rpm: ['Verboo Code-0.2.2.alpha.7-1.x86_64.rpm'],
    },
  },
}

/**
 * Stage one platform's bundle tree.
 * @param root - directory standing in for the Tauri target directory.
 * @param label - release label selecting the layout.
 * @param options.signed - whether the updater bundle carries its signature file.
 * @returns The staged bundle root and asset directory.
 */
async function stage(root, label, { signed = true } = {}) {
  const { target, files } = layouts[label]
  for (const [directory, names] of Object.entries(files)) {
    const path = join(root, target, 'release/bundle', directory)
    await mkdir(path, { recursive: true })
    for (const name of names) await writeFile(join(path, name), `bundle:${label}:${name}`)
  }
  const updaterDirectories = label === 'Windows-x64'
    ? ['nsis']
    : label.startsWith('macOS')
      ? ['macos']
      : ['appimage', 'deb', 'rpm']
  if (signed) {
    for (const directory of updaterDirectories) {
      const bundleDirectory = join(root, target, 'release/bundle', directory)
      const [bundle] = files[directory]
      await writeFile(join(bundleDirectory, `${bundle}.sig`), `${signature}\n`)
    }
  }
  const assets = join(root, 'assets')
  return { bundles: root, assets }
}

test('collects each Linux installer as its own signed updater bundle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'verboo-collect-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const staged = await stage(root, 'Linux-x64')
  await run(process.execPath, [join(desktop, 'tauri/collect-release.mjs')], {
    env: {
      ...process.env,
      RELEASE_LABEL: 'Linux-x64',
      RELEASE_TARGET: layouts['Linux-x64'].target,
      GITHUB_SHA: source,
      VERBOO_RELEASE_BUNDLES: staged.bundles,
      VERBOO_RELEASE_ASSETS: staged.assets,
    },
  })
  const manifest = JSON.parse(await readFile(join(staged.assets, 'manifest-Linux-x64.json'), 'utf8'))
  assert.equal(manifest.source, source)
  assert.deepEqual(manifest.installers.map(entry => entry.name), [
    `Verboo-Code-v2-${configuration.version}-Linux-x64.AppImage`,
    `Verboo-Code-v2-${configuration.version}-Linux-x64.deb`,
    `Verboo-Code-v2-${configuration.version}-Linux-x64.rpm`,
  ])
  assert.deepEqual(manifest.updaters.map(entry => [entry.target, entry.name]), [
    ['linux-x86_64-appimage', `Verboo-Code-v2-${configuration.version}-Linux-x64.AppImage`],
    ['linux-x86_64-deb', `Verboo-Code-v2-${configuration.version}-Linux-x64.deb`],
    ['linux-x86_64-rpm', `Verboo-Code-v2-${configuration.version}-Linux-x64.rpm`],
  ])
  for (const [index, updater] of manifest.updaters.entries()) {
    assert.equal(updater.signature, signature)
    assert.equal(updater.sha256, manifest.installers[index].sha256)
  }
})

test('archives the macOS application bundle instead of the disk image', async t => {
  const root = await mkdtemp(join(tmpdir(), 'verboo-collect-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const staged = await stage(root, 'macOS-Apple-Silicon')
  await run(process.execPath, [join(desktop, 'tauri/collect-release.mjs')], {
    env: {
      ...process.env,
      RELEASE_LABEL: 'macOS-Apple-Silicon',
      RELEASE_TARGET: layouts['macOS-Apple-Silicon'].target,
      GITHUB_SHA: source,
      VERBOO_RELEASE_BUNDLES: staged.bundles,
      VERBOO_RELEASE_ASSETS: staged.assets,
    },
  })
  const manifest = JSON.parse(await readFile(join(staged.assets, 'manifest-macOS-Apple-Silicon.json'), 'utf8'))
  assert.equal(manifest.updaters[0].name, `Verboo-Code-v2-${configuration.version}-macOS-Apple-Silicon.app.tar.gz`)
})

test('rejects a bundle set without the updater signature', async t => {
  const root = await mkdtemp(join(tmpdir(), 'verboo-collect-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const staged = await stage(root, 'Linux-x64', { signed: false })
  await assert.rejects(run(process.execPath, [join(desktop, 'tauri/collect-release.mjs')], {
    env: {
      ...process.env,
      RELEASE_LABEL: 'Linux-x64',
      RELEASE_TARGET: layouts['Linux-x64'].target,
      GITHUB_SHA: source,
      VERBOO_RELEASE_BUNDLES: staged.bundles,
      VERBOO_RELEASE_ASSETS: staged.assets,
    },
  }))
})
