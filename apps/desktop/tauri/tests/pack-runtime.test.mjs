import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { packRuntime } from '../pack-runtime.mjs'

const run = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const manager = join(repositoryRoot, 'node_modules/pnpm/bin/pnpm.cjs')

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
    await run('tar', ['-czf', archive, '-C', directory, 'package'])
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
