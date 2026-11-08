/**
 * Publish the update feed the installed application reads.
 *
 * The feed cannot live on `releases/latest`: every Verboo release is a
 * prerelease, and that URL never resolves to one. It is committed to a dedicated
 * branch instead, which resolves for any version and keeps the download URLs of
 * the published installers unchanged.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Break a release version into the parts that order it.
 * @param version - `major.minor.patch` with an optional prerelease segment.
 * @returns Major, minor, patch, release rank, and the prerelease counter.
 */
export function releaseOrder(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version ?? '')
  if (match === null) throw new Error(`update feed: invalid version ${String(version)}`)
  const prerelease = match[4]
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    prerelease === undefined ? 1 : 0,
    prerelease === undefined ? 0 : Number(/(\d+)$/.exec(prerelease)?.[1] ?? 0),
  ]
}

/**
 * Decide whether a candidate version may replace the published one.
 * @param candidate - Version about to be published.
 * @param published - Version the feed carries, or null when it carries none.
 * @returns Whether the feed advances.
 */
export function advances(candidate, published) {
  if (published === null) return true
  const left = releaseOrder(candidate)
  const right = releaseOrder(published)
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

/**
 * Commit the verified feed to its branch.
 * @param options.feed - The verified `latest.json` content.
 * @param options.repository - `owner/name` the release belongs to.
 * @param options.source - Exact source SHA the release was built from.
 * @param options.branch - Branch holding the feed.
 * @param options.github - GitHub API adapter.
 * @returns The published version, branch, commit and public URL.
 */
export async function publishFeed({ feed, repository, source, branch, github }) {
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(source ?? '')) {
    throw new Error('update feed: repository and exact source SHA are required')
  }
  if (!/^[a-z0-9-]+$/.test(branch ?? '')) throw new Error('update feed: invalid branch name')
  const version = feed?.version
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error('update feed: invalid version')
  if (feed?.platforms === null || typeof feed?.platforms !== 'object' || Object.keys(feed.platforms).length === 0) {
    throw new Error('update feed: no platforms')
  }
  const prefix = `/repos/${repository}`
  const reference = await github('GET', `${prefix}/git/ref/heads/${branch}`)
  if (reference === null) {
    const created = await github('POST', `${prefix}/git/refs`, { ref: `refs/heads/${branch}`, sha: source })
    if (created === null) throw new Error('update feed: branch was not created')
  }
  const path = `${prefix}/contents/latest.json`
  const current = await github('GET', `${path}?ref=${branch}`)
  if (current !== null && current.content !== undefined) {
    const published = JSON.parse(Buffer.from(current.content, 'base64').toString('utf8'))?.version ?? null
    // A re-run of an older release must not move the feed backwards, and an
    // identical version is already published.
    if (!advances(version, published)) throw new Error(`update feed: ${version} does not advance ${String(published)}`)
  }
  const written = await github('PUT', path, {
    message: `chore(update-feed): publish ${version}`,
    content: Buffer.from(`${JSON.stringify(feed, null, 2)}\n`).toString('base64'),
    branch,
    ...(current === null ? {} : { sha: current.sha }),
  })
  if (written === null) throw new Error('update feed: commit was not confirmed')
  return { version, branch, commit: written.commit?.sha ?? null, url: `https://raw.githubusercontent.com/${repository}/${branch}/latest.json` }
}

/** Read the GitHub environment and publish the feed file named on the command line. */
async function main() {
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('GitHub release token is required')
  const path = resolve(process.argv[2] ?? 'update-feed/latest.json')
  const github = async (method, endpoint, body) => {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`update feed request failed: HTTP ${response.status}`)
    return response.json()
  }
  console.log(JSON.stringify(await publishFeed({
    feed: JSON.parse(await readFile(path, 'utf8')),
    repository: process.env.GITHUB_REPOSITORY,
    source: process.env.GITHUB_SHA,
    branch: process.env.VERBOO_UPDATE_FEED_BRANCH ?? 'update-feed',
    github,
  })))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Update feed publication was not confirmed'); process.exitCode = 1 })
}
