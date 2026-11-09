/** Real-profile integration coverage for the Tauri-owned Node process. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const host = process.env.VERBOO_TEST_HOST_MODULE ?? join(repository, 'apps/desktop/tauri/host.mjs')
const manifest = process.env.VERBOO_TEST_CLI_MANIFEST ?? join(repository, 'apps/cli/package.json')
const prefix = 'VERBOO_HOST_V1\t'

async function start(t, cli = manifest, browserOverride = false) {
  const home = await mkdtemp(join(tmpdir(), 'verboo-tauri-host-'))
  if (browserOverride) await writeFile(join(home, 'cordis.patch.yml'), '- id: web-runtime\n  config:\n    openBrowser: true\n    printUrl: false\n    surfaceContext: true\n')
  const probe = fileURLToPath(new URL('./fixtures/browser-opener-probe.mjs', import.meta.url))
  const child = spawn(process.execPath, ['--import', probe, host, cli], {
    cwd: repository, env: { ...process.env, DSH_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const events = []
  const waiters = []
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    if (!line.startsWith(prefix)) return
    const event = JSON.parse(line.slice(prefix.length))
    events.push(event)
    for (const waiter of waiters) waiter(event)
  })
  // Drain plugin diagnostics without ever printing configuration or a bootstrap URL.
  const diagnostics = createInterface({ input: child.stderr })
  const browserRequests = []
  diagnostics.on('line', line => {
    if (line.startsWith('Verboo Code: host_boot_failed')) t.diagnostic(line)
    if (line === 'VERBOO_TEST_BROWSER_HANDOFF') browserRequests.push(line)
  })
  const exit = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await exit }
    lines.close()
    diagnostics.close()
    await rm(home, { recursive: true, force: true })
  })
  const event = (type) => {
    const present = events.find(event => event.type === type)
    if (present !== undefined) return Promise.resolve(present)
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Host did not emit ${type}`)), 30_000)
      waiters.push((event) => {
        if (event.type === type) { clearTimeout(deadline); resolve(event) }
      })
      exit.then(() => { clearTimeout(deadline); reject(new Error(`Host exited before ${type}`)) })
    })
  }
  return { child, event, exit, events, browserRequests }
}

test('keeps chat in the native window even when a user patch enables browser startup', { timeout: 45_000 }, async (t) => {
  const { child, event, exit, browserRequests } = await start(t, manifest, true)
  const { url } = await event('ready')
  const response = await fetch(new URL(url).origin)
  assert.equal(response.status, 401)
  child.stdin.write('{"type":"shutdown"}\n')
  assert.equal((await exit)[0], 0)
  assert.deepEqual(browserRequests, [], 'desktop startup must never hand the chat to the system browser')
})

test('serves authenticated application assets and disposes the same Host after repeated shutdown', { timeout: 45_000 }, async (t) => {
  const { child, event, exit, events, browserRequests } = await start(t)
  const { url } = await event('ready')
  const origin = new URL(url).origin
  const unauthorized = await fetch(origin)
  assert.equal(unauthorized.status, 401)
  const bootstrap = await fetch(url, { redirect: 'manual' })
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'the owned WebView must receive an authentication cookie')
  const page = await fetch(origin, { headers: { cookie } })
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /<div id="root">/)
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1])
  assert.ok(assets.length > 0)
  for (const asset of assets) {
    const response = await fetch(new URL(asset, origin), { headers: { cookie } })
    assert.equal(response.status, 200)
    await response.arrayBuffer()
  }
  child.stdin.write('{"type":"shutdown"}\n{"type":"shutdown"}\n')
  const [code] = await exit
  assert.equal(code, 0)
  assert.equal(events.filter(event => event.type === 'stopped').length, 1)
  assert.deepEqual(browserRequests, [], 'normal desktop startup must keep the chat in its native window')
  await assert.rejects(fetch(origin))
  const observation = {
    authenticationRequired: unauthorized.status,
    authenticatedPage: page.status,
    javascriptAndStylesheets: assets.length,
    shutdownExit: code,
    events: events.map(event => event.type),
  }
  const expected = JSON.parse(await readFile(new URL('./host.expected.json', import.meta.url), 'utf8'))
  assert.deepEqual(observation, expected)
})

test('parent disconnection during startup leaves no Host process', { timeout: 30_000 }, async (t) => {
  const { child, exit } = await start(t)
  child.stdin.end()
  const [code] = await exit
  assert.equal(code, 0)
})

test('parent disconnection after readiness closes pipes and disposes the Host', { timeout: 30_000 }, async (t) => {
  const { child, event, exit } = await start(t)
  const { url } = await event('ready')
  child.stdout.destroy()
  child.stdin.end()
  const [code] = await exit
  assert.equal(code, 0)
  await assert.rejects(fetch(new URL(url).origin))
})

test('failed startup reports a fixed code and exits unsuccessfully', { timeout: 10_000 }, async (t) => {
  const { event, exit } = await start(t, join(repository, 'missing-tauri-runtime/package.json'))
  const failure = await event('fatal')
  const [code] = await exit
  assert.deepEqual(failure, { type: 'fatal', code: 'host_boot_failed' })
  assert.equal(code, 1)
})

test('malformed input cannot stop the live Host', { timeout: 45_000 }, async (t) => {
  const { child, event, exit } = await start(t)
  await event('ready')
  child.stdin.write('not json\n')
  assert.deepEqual(await event('invalid-command'), { type: 'invalid-command' })
  assert.equal(child.exitCode, null)
  child.stdin.write('{"type":"shutdown"}\n')
  assert.equal((await exit)[0], 0)
})
