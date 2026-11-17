import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyBuildRun } from '../verify-build-run.mjs'

const repository = 'verbeux-ai/verboo-code-v2'
const source = 'a'.repeat(40)
const run = { head_sha: source, repository: { full_name: repository }, head_repository: { full_name: repository }, path: '.github/workflows/verboo-desktop-release.yml', event: 'workflow_dispatch' }
const success = name => ({ name, status: 'completed', conclusion: 'success' })
const jobs = { total_count: 2, jobs: [success('Build Windows-x64'), success('Build Linux-x64')] }
const options = { source, repository, omitArm: true, omitIntel: true }

test('admits completed Windows and Linux builds only with explicit macOS omissions', () => {
  assert.equal(verifyBuildRun(run, jobs, options).length, 2)
  assert.throws(() => verifyBuildRun(run, jobs, { ...options, omitIntel: false }))
  assert.throws(() => verifyBuildRun(run, jobs, { ...options, omitArm: false }))
})

test('rejects another source, fork, workflow or untrusted PR run', () => {
  for (const change of [{ head_sha: 'b'.repeat(40) }, { head_repository: { full_name: 'fork/repo' } }, { path: '.github/workflows/ci.yml' }, { event: 'pull_request' }]) {
    assert.throws(() => verifyBuildRun({ ...run, ...change }, jobs, options))
  }
})

test('rejects failed, unfinished, duplicate or incomplete selected jobs', () => {
  for (const selected of [
    [success('Build Windows-x64')],
    [success('Build Windows-x64'), { ...success('Build Linux-x64'), conclusion: 'failure' }],
    [success('Build Windows-x64'), { ...success('Build Linux-x64'), status: 'in_progress' }],
    [...jobs.jobs, success('Build Linux-x64')],
  ]) assert.throws(() => verifyBuildRun(run, { total_count: selected.length, jobs: selected }, options))
  assert.throws(() => verifyBuildRun(run, { ...jobs, total_count: 100 }, options))
})
