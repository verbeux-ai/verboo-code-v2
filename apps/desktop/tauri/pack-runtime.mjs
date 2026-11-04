/** Pack the complete workspace dependency and peer closure before installing the standalone Host. */
import { globSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`runtime package command exited ${code}`)))
  })
}

function supported(values, current) {
  if (values === undefined) return true
  return !values.includes(`!${current}`) && (values.includes('any')
    || values.every(value => value.startsWith('!')) || values.includes(current))
}

/**
 * Install local packages with peer providers and the reviewed dependency patches.
 * @param options - Source repository, private staging directory and pinned package manager.
 * @returns The generated npm-project directory.
 */
export async function packRuntime({ repository, staging, packageManager, registry = 'https://registry.npmjs.org', storeDir }) {
  const require = createRequire(join(repository, 'package.json'))
  const yaml = require('js-yaml')
  const policy = yaml.load(readFileSync(join(repository, 'pnpm-workspace.yaml'), 'utf8'))
  const packages = new Map(globSync(policy.packages.map(pattern => `${pattern}/package.json`), { cwd: repository })
    .map(path => {
      const manifest = JSON.parse(readFileSync(join(repository, path), 'utf8'))
      return [manifest.name, manifest]
    }))
  const selected = new Map()
  const visit = name => {
    if (selected.has(name)) return
    const manifest = packages.get(name)
    if (manifest === undefined) return
    selected.set(name, manifest)
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        const candidate = packages.get(dependency)
        if (section === 'optionalDependencies' && candidate !== undefined
          && (!supported(candidate.os, process.platform) || !supported(candidate.cpu, process.arch))) continue
        visit(dependency)
      }
    }
  }
  visit('@deepseek-ai/dsh')
  const application = join(staging, 'application')
  const tarballs = join(application, 'packages')
  await mkdir(tarballs, { recursive: true })
  const userconfig = join(staging, 'pnpm-userconfig')
  await writeFile(userconfig, '')
  const configuration = [`--config.registry=${registry}`, `--config.userconfig=${userconfig}`,
    ...(storeDir ? [`--config.store-dir=${storeDir}`, `--config.cache-dir=${join(staging, 'registry-cache')}`] : [])]
  await run(process.execPath, [packageManager, ...configuration, ...[...selected.keys()].sort().flatMap(name => ['--filter', name]),
    '--recursive', 'pack', '--workspace-concurrency=4', '--pack-destination', tarballs], repository)
  const dependencies = {}
  for (const manifest of selected.values()) {
    const filename = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
    dependencies[manifest.name] = `file:packages/${filename}`
  }
  const rootManifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
  dependencies.pnpm = rootManifest.devDependencies.pnpm
  await writeFile(join(application, 'package.json'), JSON.stringify({
    name: '@verboo-code/desktop-runtime', private: true, type: 'module', dependencies,
  }, null, 2) + '\n')
  const patches = {}
  for (const [name, path] of Object.entries(policy.patchedDependencies ?? {})) {
    const destination = join(application, 'patches', basename(path))
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(repository, path), destination)
    patches[name] = `patches/${basename(path)}`
  }
  const allowBuilds = { ...policy.allowBuilds }
  for (const [identity, allowed] of Object.entries(policy.allowBuilds ?? {})) {
    const separator = identity.indexOf('@file:')
    if (separator === -1) continue
    const name = identity.slice(0, separator)
    const specifier = dependencies[name]
    if (specifier !== undefined) allowBuilds[`${name}@${specifier}`] = allowed
  }
  const patchVersions = {}
  for (const spec of Object.keys(patches)) {
    const separator = spec.lastIndexOf('@')
    const name = spec.slice(0, separator)
    const version = spec.slice(separator + 1)
    if (separator <= 0 || (patchVersions[name] && patchVersions[name] !== version)) throw new Error('runtime patch versions require review')
    patchVersions[name] = version
  }
  await writeFile(join(application, 'pnpm-workspace.yaml'), yaml.dump({
    packages: [],
    nodeLinker: 'hoisted',
    overrides: { ...policy.overrides, ...patchVersions, ...dependencies },
    allowBuilds,
    minimumReleaseAgeExclude: policy.minimumReleaseAgeExclude,
    patchedDependencies: patches,
    // The Host closure excludes desktop installer and test dependencies that own other reviewed patches.
    allowUnusedPatches: true,
  }))
  // A frozen workspace install need not populate registry metadata. Resolve a
  // separate runtime lock before materialization so a fresh builder works too.
  await run(process.execPath, [packageManager, ...configuration, 'install', '--prod', '--lockfile-only', '--prefer-offline'], application)
  const bytes = readFileSync(join(application, 'pnpm-lock.yaml'))
  const lock = yaml.load(bytes.toString('utf8'))
  const reviewed = yaml.load(readFileSync(join(repository, 'pnpm-lock.yaml'), 'utf8'))
  for (const spec of Object.keys(patches)) {
    const name = spec.slice(0, spec.lastIndexOf('@'))
    const present = Object.keys(lock.packages ?? {}).filter(key => key.startsWith(`${name}@`))
    if (present.length === 0) continue
    if (present.some(key => key !== spec && !key.startsWith(`${spec}(`))
      || lock.patchedDependencies?.[spec] !== reviewed.patchedDependencies?.[spec]) throw new Error('runtime patch differs from reviewed workspace bytes')
  }
  console.log(`Verboo Code: runtime lock SHA-256 ${createHash('sha256').update(bytes).digest('hex')}`)
  await run(process.execPath, [packageManager, ...configuration, 'install', '--prod', '--frozen-lockfile', '--prefer-offline', '--config.package-import-method=clone-or-copy'], application)
  return application
}
