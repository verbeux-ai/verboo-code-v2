import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { packRuntime } from '../pack-runtime.mjs'
import { selectRuntimeTarget } from '../prepare-runtime.mjs'

const run = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const manager = join(repositoryRoot, 'node_modules/pnpm/bin/pnpm.cjs')

test('Linux desktop keeps glibc and the sandbox launcher while excluding the incompatible musl addon', async t => {
  const application = await mkdtemp(join(tmpdir(), 'verboo-runtime-target-'))
  t.after(() => rm(application, { recursive: true, force: true }))
  const bin = join(application, 'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin')
  for (const libc of ['glibc', 'musl']) {
    await mkdir(join(bin, libc), { recursive: true })
    await writeFile(join(bin, libc, 'system.node'), `${libc}-fixture`)
  }
  await writeFile(join(bin, 'landlock-run'), 'static-sandbox-fixture', { mode: 0o755 })
  const ffi = join(application, 'node_modules/@koromix/koffi-linux-x64')
  const pty = join(application, 'node_modules/node-pty/prebuilds')
  for (const target of ['linux_x64', 'musl_x64']) {
    await mkdir(join(ffi, target), { recursive: true })
    await writeFile(join(ffi, target, 'koffi.node'), `${target}-ffi`)
  }
  for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64']) {
    await mkdir(join(pty, target), { recursive: true })
    await writeFile(join(pty, target, 'pty.node'), `${target}-pty`)
  }
  const launcherMode = (await stat(join(bin, 'landlock-run'))).mode
  await selectRuntimeTarget(application, { platform: 'darwin', arch: 'arm64' })
  await access(join(bin, 'musl/system.node'))
  await selectRuntimeTarget(application, { platform: 'linux', arch: 'x64' })
  assert.equal(await readFile(join(bin, 'glibc/system.node'), 'utf8'), 'glibc-fixture')
  assert.equal(await readFile(join(bin, 'landlock-run'), 'utf8'), 'static-sandbox-fixture')
  assert.equal((await stat(join(bin, 'landlock-run'))).mode, launcherMode)
  assert.equal(await readFile(join(ffi, 'linux_x64/koffi.node'), 'utf8'), 'linux_x64-ffi')
  assert.equal(await readFile(join(pty, 'linux-x64/pty.node'), 'utf8'), 'linux-x64-pty')
  await assert.rejects(access(join(ffi, 'musl_x64')), { code: 'ENOENT' })
  for (const target of ['linux-arm64', 'darwin-arm64', 'win32-x64']) await assert.rejects(access(join(pty, target)), { code: 'ENOENT' })
  await assert.rejects(access(join(bin, 'musl')), { code: 'ENOENT' })
  await selectRuntimeTarget(application, { platform: 'linux', arch: 'x64' })
  await rm(join(bin, 'glibc/system.node'))
  await assert.rejects(selectRuntimeTarget(application, { platform: 'linux', arch: 'x64' }), { code: 'ENOENT' })
  await assert.rejects(selectRuntimeTarget(application, { platform: 'linux', arch: 'unknown' }), /unsupported/)
})

test('builds from an empty registry cache and freezes the resulting runtime', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'verboo-runtime-cache-'))
  const packages = new Map()
  const requests = []
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname.slice(1)
    requests.push(path)
    const name = path.endsWith('.tgz') ? path.slice(0, -4) : path
    const item = packages.get(name)
    if (!item) { response.writeHead(404); response.end(); return }
    if (path.endsWith('.tgz')) { response.end(item.bytes); return }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ name, 'dist-tags': { latest: item.version },
      time: { [item.version]: '2020-01-01T00:00:00.000Z' },
      versions: { [item.version]: { ...item.manifest, dist: { tarball: `${registry}/${name}.tgz`, integrity: item.integrity } } } }))
  })
  t.after(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const registry = `http://127.0.0.1:${server.address().port}`
  for (const [name, version] of [['pnpm', '11.28.5'], ['fixture-runtime-dependency', '1.0.0']]) {
    const directory = join(root, 'registry', name)
    await mkdir(join(directory, 'package'), { recursive: true })
    const manifest = { name, version, main: 'index.js' }
    await writeFile(join(directory, 'package/package.json'), JSON.stringify(manifest))
    await writeFile(join(directory, 'package/index.js'), 'module.exports = "locked-runtime-fixture"\n')
    const archive = join(directory, 'package.tgz')
    await run('tar', ['-czf', 'package.tgz', 'package'], { cwd: directory })
    const bytes = await readFile(archive)
    packages.set(name, { version, manifest, bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` })
  }
  const userconfig = join(root, 'npmrc')
  await writeFile(userconfig, '')
  const cold = join(root, 'cold')
  await mkdir(cold)
  await writeFile(join(cold, 'package.json'), JSON.stringify({ private: true, dependencies: { 'fixture-runtime-dependency': '^1.0.0' } }))
  const configuration = [`--config.registry=${registry}`, `--config.store-dir=${join(root, 'store')}`,
    `--config.cache-dir=${join(root, 'staging/registry-cache')}`, `--config.userconfig=${userconfig}`]
  await run(process.execPath, [manager, ...configuration, 'install', '--offline'], { cwd: cold, env: process.env }).then(
    result => assert.fail(`offline resolution unexpectedly succeeded: ${result.stdout} ${result.stderr}`),
    error => assert.match(error.stdout + error.stderr, /NO_OFFLINE_(META|TARBALL)/),
  )
  assert.equal(requests.length, 0)

  const repository = join(root, 'source')
  await mkdir(join(repository, 'apps/cli/lib'), { recursive: true })
  await mkdir(join(repository, 'node_modules'), { recursive: true })
  await symlink(join(repositoryRoot, 'node_modules/js-yaml'), join(repository, 'node_modules/js-yaml'), 'junction')
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true, devDependencies: { pnpm: '11.28.5' } }))
  await writeFile(join(repository, 'pnpm-workspace.yaml'), 'packages: [apps/*]\nallowBuilds: {}\n')
  await writeFile(join(repository, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  await writeFile(join(repository, 'apps/cli/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', files: ['lib'], dependencies: { 'fixture-runtime-dependency': '^1.0.0' } }))
  await writeFile(join(repository, 'apps/cli/lib/profile-boot.js'), 'export const fixture = true\n')
  const staging = join(root, 'staging')
  const application = await packRuntime({ repository, staging, packageManager: manager, registry, storeDir: join(root, 'store') })
  const manifest = JSON.parse(await readFile(join(application, 'node_modules/fixture-runtime-dependency/package.json'), 'utf8'))
  assert.equal(manifest.version, '1.0.0')
  assert.ok(requests.includes('pnpm') && requests.includes('fixture-runtime-dependency'))
  const lock = await readFile(join(application, 'pnpm-lock.yaml'), 'utf8')
  assert.match(lock, /sha512-/)
  await rm(join(application, 'node_modules'), { recursive: true, force: true })
  await run(process.execPath, [manager, ...configuration, 'install', '--prod', '--frozen-lockfile', '--offline'], { cwd: application, env: process.env })
  assert.equal(await readFile(join(application, 'pnpm-lock.yaml'), 'utf8'), lock)
})
