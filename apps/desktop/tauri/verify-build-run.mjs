/** Admit completed installer jobs from the trusted release workflow before downloading artifacts. */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Require the exact repository, source, workflow and successful selected platform jobs.
 * @param run - GitHub build run metadata.
 * @param jobs - Latest-attempt job response.
 * @param options - Requested source, repository and explicit macOS omissions.
 * @returns The required build job names.
 */
export function verifyBuildRun(run, jobs, { source, repository, omitArm, omitIntel }) {
  if (!/^[a-f0-9]{40}$/.test(source ?? '') || repository !== 'verbeux-ai/verboo-code-v2'
    || run?.head_sha !== source || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || run.path !== '.github/workflows/verboo-desktop-release.yml' || !['workflow_dispatch', 'release'].includes(run.event)) {
    throw new Error('Installer build run does not match the trusted release source')
  }
  if (!Array.isArray(jobs?.jobs) || jobs.total_count !== jobs.jobs.length) throw new Error('Incomplete build job inventory')
  const required = ['Build Windows-x64', 'Build Linux-x64']
  if (!omitArm) required.push('Build macOS-Apple-Silicon')
  if (!omitIntel) required.push('Build macOS-Intel')
  for (const name of required) {
    const matching = jobs.jobs.filter(job => job.name === name)
    if (matching.length !== 1 || matching[0].status !== 'completed' || matching[0].conclusion !== 'success') {
      throw new Error(`Required installer build is not successful: ${name}`)
    }
  }
  return required
}

async function main() {
  const id = process.env.BUILD_RUN
  if (!/^[1-9][0-9]*$/.test(id ?? '') || !process.env.GH_TOKEN) throw new Error('A build run ID and GitHub token are required')
  const repository = process.env.GITHUB_REPOSITORY
  if (repository !== 'verbeux-ai/verboo-code-v2') throw new Error('Unexpected release repository')
  for (const name of ['VERBOO_RELEASE_OMIT_MACOS_ARM64', 'VERBOO_RELEASE_OMIT_MACOS_INTEL']) {
    if (process.env[name] !== undefined && !['true', 'false'].includes(process.env[name])) throw new Error('Invalid platform omission setting')
  }
  const read = async path => {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${id}${path}`, {
      redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' },
    })
    if (!response.ok) throw new Error(`Build metadata request failed: HTTP ${response.status}`)
    return response.json()
  }
  const [run, jobs] = await Promise.all([read(''), read('/jobs?filter=latest&per_page=100')])
  console.log(JSON.stringify({ verifiedJobs: verifyBuildRun(run, jobs, {
    source: process.env.RELEASE_SOURCE, repository,
    omitArm: process.env.VERBOO_RELEASE_OMIT_MACOS_ARM64 === 'true', omitIntel: process.env.VERBOO_RELEASE_OMIT_MACOS_INTEL === 'true',
  }) }))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Build run verification failed'); process.exitCode = 1 })
}
