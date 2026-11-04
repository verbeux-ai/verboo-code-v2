import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { publishRelease, releaseSpec } from '../publish-release.mjs'

const source = 'a'.repeat(40)
const repository = 'verbeux-ai/verboo-code-v2'
const spec = releaseSpec({ eventName: 'workflow_dispatch', event: {}, version: '0.2.2-alpha.3', source, repository })
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'verboo-publish-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  for (const name of ['RELEASE.md', 'SHA256SUMS', 'installer.dmg']) await writeFile(join(directory, name), `verified:${name}`)
  const state = { release: null, tag: null, writes: [], uploads: [], failUpload: false, deferTag: false, annotatedTag: false }
  const github = async (method, path, body) => {
    if (method === 'GET') {
      if (path.includes('/git/ref/')) return state.tag === null ? null : { object: { type: state.annotatedTag ? 'tag' : 'commit', sha: state.annotatedTag ? 'b'.repeat(40) : state.tag } }
      if (path.includes('/git/tags/')) return { object: { type: 'commit', sha: state.tag } }
      if (path.includes('/releases?')) return state.release === null ? [] : [structuredClone(state.release)]
      return structuredClone(state.release)
    }
    state.writes.push({ method, path, body })
    if (method === 'POST') {
      state.tag = state.deferTag ? null : body.target_commitish
      state.release = { id: 1, tag_name: body.tag_name, draft: true, target_commitish: source, assets: [], html_url: `https://github.com/${repository}/releases/tag/${spec.tag}` }
    } else if (method === 'PATCH') { state.release.draft = body.draft; state.tag = source }
    return structuredClone(state.release)
  }
  const upload = async (tag, files) => {
    state.uploads.push({ tag, files: files.map(path => basename(path)) })
    for (const path of files) {
      const bytes = await readFile(path)
      state.release.assets.push({ name: basename(path), size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, state: 'uploaded' })
      if (state.failUpload) throw new Error('upload result unconfirmed')
    }
  }
  const publish = (input = spec) => publishRelease({ spec: input, directory, github, upload })
  return { state, publish, directory }
}
test('accepts published releases and rejects an unrelated tag, source or repository before a build', () => {
  const event = { action: 'published', release: { tag_name: spec.tag, draft: false } }
  assert.equal(releaseSpec({ eventName: 'release', event, version: spec.version, source, repository }).tag, spec.tag)
  for (const input of [
    { eventName: 'push', event, version: spec.version, source, repository },
    { eventName: 'release', event: { ...event, release: { tag_name: 'v9.0.0', draft: false } }, version: spec.version, source, repository },
    { eventName: 'release', event, version: spec.version, source: 'branch', repository },
    { eventName: 'release', event, version: spec.version, source, repository: 'deepseek-ai/deepseek-harness' },
  ]) assert.throws(() => releaseSpec(input))
})
test('a manual build makes a draft public only after every digest is confirmed', async t => {
  const f = await fixture(t)
  const result = await f.publish()
  assert.equal(result.url, `https://github.com/${repository}/releases/tag/${spec.tag}`)
  assert.equal(f.state.release.draft, false)
  assert.deepEqual(f.state.writes.map(write => write.method), ['POST', 'PATCH'])
  assert.equal(f.state.uploads.length, 1)
  await f.publish()
  assert.equal(f.state.writes.length, 2)
  assert.equal(f.state.uploads.length, 1)
})
test('a release event attaches to the existing public release without creating another one', async t => {
  const f = await fixture(t)
  await f.publish()
  f.state.release.assets = []
  f.state.writes = []
  await f.publish({ ...spec, eventName: 'release' })
  assert.equal(f.state.writes.length, 0)
  assert.equal(f.state.uploads.length, 2)
  assert.equal(f.state.release.draft, false)
})
test('an unconfirmed upload is inspected and only its missing files are retried on another run', async t => {
  const f = await fixture(t)
  f.state.failUpload = true
  await assert.rejects(f.publish(), /unconfirmed/)
  assert.equal(f.state.release.draft, true)
  assert.equal(f.state.writes.length, 1)
  assert.equal(f.state.release.assets.length, 1)
  const first = f.state.release.assets[0].name
  f.state.failUpload = false
  await f.publish()
  assert(!f.state.uploads[1].files.includes(first))
  assert.equal(f.state.release.draft, false)
})
test('a missing published release is not recreated', async t => {
  const f = await fixture(t)
  await assert.rejects(f.publish({ ...spec, eventName: 'release' }), /disappeared/)
  assert.equal(f.state.writes.length, 0)
  assert.equal(f.state.uploads.length, 0)
})
for (const failure of ['different tag source', 'different bytes', 'unexpected asset', 'missing upload']) {
  test(`does not replace published content or report success after ${failure}`, async t => {
    const f = await fixture(t)
    await f.publish()
    f.state.writes = []
    if (failure === 'different tag source') f.state.tag = 'b'.repeat(40)
    if (failure === 'different bytes') f.state.release.assets[0].digest = `sha256:${'0'.repeat(64)}`
    if (failure === 'unexpected asset') f.state.release.assets.push({ name: 'foreign.zip', size: 1, state: 'uploaded', digest: `sha256:${'0'.repeat(64)}` })
    if (failure === 'missing upload') { f.state.release.assets.pop(); f.state.failUpload = true }
    await assert.rejects(f.publish())
    assert.equal(f.state.writes.length, 0)
    assert.equal(f.state.release.draft, false)
  })
}

test('supports a new draft whose exact-source tag is created only when it becomes public', async t => {
 const f=await fixture(t)
 f.state.deferTag=true
 await f.publish()
 assert.equal(f.state.release.draft,false)
 assert.equal(f.state.tag,source)
})

test('resolves an annotated tag to the exact manifest source', async t => {
 const f=await fixture(t)
 f.state.annotatedTag=true
 await f.publish()
 assert.equal(f.state.release.draft,false)
})
