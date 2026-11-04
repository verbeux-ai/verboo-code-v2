/** Attach verified installers to the exact release tag without replacing published bytes. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Validate the published tag or the version selected by a manual build before packaging.
 * @param options - GitHub event, committed product version, repository and source SHA.
 * @returns The tag and source used by every platform build and publication.
 */
export function releaseSpec({ eventName, event, version, source, repository }) {
  if (repository !== 'verbeux-ai/verboo-code-v2' || !/^[a-f0-9]{40}$/.test(source ?? '') || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error('Invalid Verboo release identity')
  const tag = `v${version}`
  if (eventName === 'release') {
    if (event.action !== 'published' || event.release?.draft !== false || event.release.tag_name !== tag) throw new Error('Release tag must match the committed desktop version')
  } else if (eventName !== 'workflow_dispatch') throw new Error('Unsupported release event')
  return { tag, version, source, repository, eventName }
}

async function tagSource(github, prefix, tag) {
  let reference = await github('GET', `${prefix}/git/ref/tags/${encodeURIComponent(tag)}`)
  if (reference === null) return null
  let object = reference.object
  for (let depth = 0; depth < 5; depth++) {
    if (!/^[a-f0-9]{40}$/.test(object?.sha ?? '')) throw new Error('Invalid release tag reference')
    if (object.type === 'commit') return object.sha
    if (object.type !== 'tag') throw new Error('Release tag does not identify a commit')
    reference = await github('GET', `${prefix}/git/tags/${object.sha}`)
    object = reference?.object
  }
  throw new Error('Release tag nesting exceeds the supported depth')
}
async function findRelease(github, prefix, tag) {
  // The by-tag endpoint excludes drafts; listing supports recovery before publication.
  for (let page = 1; page <= 100; page++) {
    const releases = await github('GET', `${prefix}/releases?per_page=100&page=${page}`)
    if (!Array.isArray(releases)) throw new Error('Release list is unavailable')
    const release = releases.find(item => item.tag_name === tag)
    if (release) return release
    if (releases.length < 100) return null
  }
  throw new Error('Release search exceeded the pagination limit')
}
function verifyAssets(release, files, complete) {
  if (!Array.isArray(release.assets)) throw new Error('Release asset metadata is unavailable')
  const seen = new Set()
  for (const asset of release.assets) {
    const file = files.get(asset.name)
    if (seen.has(asset.name) || !file || asset.state !== 'uploaded' || asset.size !== file.bytes || asset.digest !== `sha256:${file.sha256}`) throw new Error('Existing release asset differs from the verified build')
    seen.add(asset.name)
  }
  if (complete && seen.size !== files.size) throw new Error('Incomplete uploaded installer set')
  return [...files.keys()].filter(name => !seen.has(name))
}

/**
 * Resume only matching uploads and publish a manual draft after provider digest confirmation.
 * @param options - Verified source, installer directory, GitHub API and upload adapter.
 * @returns Public release URL and the installed asset names.
 */
export async function publishRelease({ spec, directory, github, upload }) {
  const files = new Map()
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.size === 0) throw new Error('Invalid release file')
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    files.set(name, { bytes: stat.size, sha256: hash.digest('hex') })
  }
  if (files.size === 0) throw new Error('No verified release files')
  const prefix = `/repos/${spec.repository}`
  const existingSource = await tagSource(github, prefix, spec.tag)
  if (existingSource !== null && existingSource !== spec.source) throw new Error('Release tag moved or identifies another source')
  let release = await findRelease(github, prefix, spec.tag)
  if (release === null) {
    if (spec.eventName === 'release') throw new Error('Published release disappeared')
    release = await github('POST', `${prefix}/releases`, {
      tag_name: spec.tag, target_commitish: spec.source, name: `Verboo Code ${spec.version}`,
      body: await readFile(join(directory, 'RELEASE.md'), 'utf8'), draft: true, prerelease: spec.version.includes('-'),
    })
  }
  if (release?.tag_name !== spec.tag || !Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.draft !== 'boolean') throw new Error('Release metadata does not match the requested tag')
  const confirmedTag = await tagSource(github, prefix, spec.tag)
  // GitHub may defer creating a new tag until its draft is published.
  if (confirmedTag !== spec.source && !(confirmedTag === null && release.draft && release.target_commitish === spec.source)) throw new Error('Release tag source is unconfirmed')
  const byID = `${prefix}/releases/${release.id}`
  const missing = verifyAssets(release, files, false)
  if (missing.length) await upload(spec.tag, missing.map(name => join(directory, name)))
  release = await github('GET', byID)
  verifyAssets(release, files, true)
  const uploadedTag = await tagSource(github, prefix, spec.tag)
  if (uploadedTag !== spec.source && !(uploadedTag === null && release.draft && release.target_commitish === spec.source)) throw new Error('Release tag changed during upload')
  if (release.draft) {
    await github('PATCH', `${prefix}/releases/${release.id}`, { draft: false })
    release = await github('GET', byID)
    verifyAssets(release, files, true)
  }
  if (await tagSource(github, prefix, spec.tag) !== spec.source) throw new Error('Published tag source is unconfirmed')
  const url = `https://github.com/${spec.repository}/releases/tag/${spec.tag}`
  if (release.draft !== false || release.html_url !== url) throw new Error('Public release could not be confirmed')
  return { url, tag: spec.tag, source: spec.source, assets: [...files.keys()] }
}

// GitHub writes are attempted once; another run reconciles provider state before writing again.
async function github(method, path, body) {
  const budget = AbortSignal.timeout(35_000)
  const safe = method === 'GET'
  for (let attempt = 0; attempt < (safe ? 3 : 1); attempt++) {
    let response
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method, redirect: 'error', signal: AbortSignal.any([budget, AbortSignal.timeout(10_000)]),
        headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      if (safe && attempt < 2 && !budget.aborted) continue
      throw new Error('GitHub release request was not confirmed', { cause: error })
    }
    if (safe && response.status === 404) { await response.body?.cancel(); return null }
    if (safe && [408,429,500,502,503,504].includes(response.status) && attempt < 2) {
      const retry = response.headers.get('retry-after')
      const delay = /^\d+$/.test(retry ?? '') ? Number(retry) * 1000 : Math.max(0, Date.parse(retry ?? '') - Date.now()) || 0
      await response.body?.cancel()
      if (delay) await new Promise((resolveDelay, reject) => {
        const timer = setTimeout(done, delay)
        function done() { budget.removeEventListener('abort', cancelled); resolveDelay() }
        function cancelled() { clearTimeout(timer); reject(new Error('GitHub read retry budget expired')) }
        budget.addEventListener('abort', cancelled, { once: true })
        if (budget.aborted) cancelled()
      })
      continue
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub release request failed: HTTP ${response.status}`) }
    return response.json()
  }
  throw new Error('GitHub release read failed')
}

async function main() {
  const configuration = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'))
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const spec = releaseSpec({ eventName: process.env.GITHUB_EVENT_NAME, event, version: configuration.version, source: process.env.GITHUB_SHA, repository: process.env.GITHUB_REPOSITORY })
  const { stdout } = await run('git', ['rev-parse', 'HEAD'])
  if (stdout.trim() !== spec.source) throw new Error('Checkout differs from the release source')
  if (process.argv[2] === '--check') { console.log(JSON.stringify(spec)); return }
  if (!process.env.GH_TOKEN) throw new Error('GitHub release token is required')
  const directory = resolve(process.argv[2])
  await run(process.execPath, [join(desktop, 'tauri/verify-release.mjs'), directory])
  const result = await publishRelease({ spec, directory, github,
    upload: (tag, files) => run('gh', ['release', 'upload', tag, ...files, '--repo', spec.repository], { maxBuffer: 1 << 20 }),
  })
  await writeFile(join(process.env.RUNNER_TEMP, 'verboo-release-result.json'), JSON.stringify(result, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `release_url=${result.url}\nrelease_tag=${result.tag}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `[Verboo Code ${configuration.version}](${result.url}) — macOS Apple Silicon, macOS Intel, Linux x64 and Windows x64.\n`)
  console.log(JSON.stringify(result))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Release publication was not confirmed'); process.exitCode = 1 })
}
