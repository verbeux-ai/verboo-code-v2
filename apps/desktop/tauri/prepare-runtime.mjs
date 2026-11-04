/** Prepare a portable, host-target Node installation and the production profile dependency closure. */
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { packRuntime } from './pack-runtime.mjs'

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`runtime preparation exited ${code}`)))
  })
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Publish a checked runtime without modifying the development home or an earlier valid runtime.
 * @param options - Repository, desktop, output and pnpm paths owned by the launcher.
 * @returns The published runtime directory.
 */
export async function prepareRuntime({ repository, desktop, output, packageManager }) {
  const runtime = join(output, 'runtime')
  const staging = join(output, 'runtime-staging')
  const previous = join(output, 'runtime-previous')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await packRuntime({ repository, staging, packageManager })
    const platform = process.platform
    if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error('unsupported Node runtime platform')
    const target = platform === 'win32' ? 'win' : platform
    const stem = `node-${process.version}-${target}-${process.arch}`
    const archiveName = `${stem}.${platform === 'win32' ? 'zip' : 'tar.gz'}`
    const base = `https://nodejs.org/dist/${process.version}`
    const checksums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8')
    const expected = checksums.split('\n').map(line => line.trim().split(/\s+/))
      .find(([, name]) => name === archiveName)?.[0]
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('official Node checksum is missing')
    const bytes = await download(`${base}/${archiveName}`)
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node archive integrity check failed')
    const archive = join(staging, archiveName)
    await writeFile(archive, bytes)
    const extracted = join(staging, 'node-source')
    await mkdir(extracted)
    if (platform === 'win32') {
      const require = createRequire(join(repository, 'package.json'))
      await require('extract-zip')(archive, { dir: extracted })
    } else {
      await run('tar', ['-xzf', archive, '-C', extracted], repository)
    }
    const node = platform === 'win32' ? 'node.exe' : 'node'
    await rename(join(extracted, stem, ...(platform === 'win32' ? [] : ['bin']), node), join(staging, node))
    await chmod(join(staging, node), 0o755)
    await copyFile(join(extracted, stem, 'LICENSE'), join(staging, 'NODE-LICENSE'))
    await rm(extracted, { recursive: true, force: true })
    await rm(archive)
    await copyFile(join(desktop, 'tauri/host.mjs'), join(staging, 'host.mjs'))
    await writeFile(join(staging, 'manifest.json'), JSON.stringify({
      node, host: 'host.mjs', cliManifest: 'application/node_modules/@deepseek-ai/dsh/package.json', workingDirectory: 'application', home: null,
    }, null, 2) + '\n')
    // Exercise the exact standalone Node binary and production dependency closure before publishing them.
    await new Promise((resolve, reject) => {
      const child = spawn(join(staging, node), ['--test', join(desktop, 'tauri/tests/host.test.mjs')], {
        cwd: repository, stdio: 'inherit',
        env: { ...process.env,
          VERBOO_TEST_CLI_MANIFEST: join(staging, 'application/node_modules/@deepseek-ai/dsh/package.json'),
          VERBOO_TEST_HOST_MODULE: join(staging, 'host.mjs'),
        },
      })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('packaged profile smoke failed')))
    })
    await rm(previous, { recursive: true, force: true })
    let moved = false
    try { await rename(runtime, previous); moved = true } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    try { await rename(staging, runtime) } catch (error) {
      if (moved) await rename(previous, runtime)
      throw error
    }
    await rm(previous, { recursive: true, force: true })
    return runtime
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
