import assert from 'node:assert/strict'
import { test } from 'node:test'
import { advances, publishFeed, releaseOrder } from '../publish-feed.mjs'

const source = 'a'.repeat(40)
const feed = version => ({ version, platforms: { 'linux-x86_64': { signature: 'c2ln', url: 'https://example.test/x' } } })

/** GitHub API double recording every request and answering from a fixed state. */
function api({ reference = null, contents = null } = {}) {
  const calls = []
  async function github(method, path, body) {
    calls.push({ method, path, body })
    if (method === 'GET' && path.endsWith('/git/ref/heads/update-feed')) return reference
    if (method === 'GET' && path.startsWith('/repos/x/y/contents/latest.json')) return contents
    if (method === 'POST' && path.endsWith('/git/refs')) return { ref: body.ref }
    if (method === 'PUT') return { commit: { sha: 'c'.repeat(40) } }
    return null
  }
  return { calls, github }
}

test('orders release versions including prereleases', () => {
  assert.deepEqual(releaseOrder('0.2.2-alpha.7'), [0, 2, 2, 0, 7])
  assert.deepEqual(releaseOrder('0.2.2'), [0, 2, 2, 1, 0])
  assert.throws(() => releaseOrder('not-a-version'))
})

test('advances only for a newer version', () => {
  assert.equal(advances('0.2.2-alpha.8', null), true)
  assert.equal(advances('0.2.2-alpha.8', '0.2.2-alpha.7'), true)
  assert.equal(advances('0.2.3-alpha.1', '0.2.2-alpha.9'), true)
  assert.equal(advances('0.2.2', '0.2.2-alpha.9'), true)
  assert.equal(advances('0.2.2-alpha.7', '0.2.2-alpha.7'), false)
  assert.equal(advances('0.2.2-alpha.6', '0.2.2-alpha.7'), false)
  assert.equal(advances('0.1.0', '0.2.2'), false)
})

test('creates the feed branch and commits the first feed', async () => {
  const { calls, github } = api()
  const result = await publishFeed({ feed: feed('0.2.2-alpha.8'), branch: 'update-feed', source, repository: 'x/y', github })
  assert.deepEqual(result, {
    version: '0.2.2-alpha.8',
    branch: 'update-feed',
    commit: 'c'.repeat(40),
    url: 'https://raw.githubusercontent.com/x/y/update-feed/latest.json',
  })
  const branch = calls.find(call => call.method === 'POST')
  assert.deepEqual(branch.body, { ref: 'refs/heads/update-feed', sha: source })
  const write = calls.find(call => call.method === 'PUT')
  assert.equal(write.body.sha, undefined)
  assert.equal(JSON.parse(Buffer.from(write.body.content, 'base64').toString('utf8')).version, '0.2.2-alpha.8')
})

test('replaces an existing feed through its current blob', async () => {
  const contents = { sha: 'd'.repeat(40), content: Buffer.from(JSON.stringify(feed('0.2.2-alpha.7'))).toString('base64') }
  const { calls, github } = api({ reference: { object: { sha: source } }, contents })
  await publishFeed({ feed: feed('0.2.2-alpha.8'), branch: 'update-feed', source, repository: 'x/y', github })
  assert.equal(calls.some(call => call.method === 'POST'), false)
  assert.equal(calls.find(call => call.method === 'PUT').body.sha, 'd'.repeat(40))
})

test('refuses to publish a version the feed already carries or a lower one', async () => {
  for (const published of ['0.2.2-alpha.8', '0.2.2-alpha.9']) {
    const contents = { sha: 'd'.repeat(40), content: Buffer.from(JSON.stringify(feed(published))).toString('base64') }
    const { calls, github } = api({ reference: { object: { sha: source } }, contents })
    await assert.rejects(publishFeed({ feed: feed('0.2.2-alpha.8'), branch: 'update-feed', source, repository: 'x/y', github }))
    assert.equal(calls.some(call => call.method === 'PUT'), false)
  }
})

test('refuses a feed without platforms', async () => {
  const { github } = api()
  await assert.rejects(publishFeed({ feed: { version: '0.2.2-alpha.8', platforms: {} }, branch: 'update-feed', source, repository: 'x/y', github }))
})
