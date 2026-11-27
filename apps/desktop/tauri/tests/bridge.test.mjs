/** Carrier readiness follows the mounted document, including a cached mount before DOMContentLoaded. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const source = await readFile(new URL('../bridge.js', import.meta.url), 'utf8')

function page(t, content) {
  const dom = new JSDOM(`<div id="root">${content}</div>`, { url: 'http://127.0.0.1:43128/', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const ready = Promise.withResolvers()
  const calls = []
  const requests = []
  dom.window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      calls.push(command)
      requests.push({ command, args })
      if (command === 'client_ready') ready.resolve()
      if (command === 'desktop_layout_read') return Promise.resolve({})
      return Promise.resolve('Verboo Code / Tauri 2')
    },
  }
  dom.window.eval(source)
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'))
  return { dom, calls, requests, ready: ready.promise }
}

test('reports a client already mounted before DOMContentLoaded', { timeout: 5000 }, async (t) => {
  const { dom, calls, ready } = page(t, '<main data-verboo-shell>workspace</main>')
  await ready
  assert.equal(calls.filter(command => command === 'client_ready').length, 1)
  assert.equal(dom.window.document.documentElement.dataset.platform, undefined)
  assert.equal(dom.window.document.documentElement.dataset.verbooDesktop, 'tauri')
  assert.equal('dshDesktop' in dom.window, false)
})

test('waits for the boot page to be replaced by the mounted client', { timeout: 5000 }, async (t) => {
  const { dom, calls, ready } = page(t, '<div data-dsh-boot>boot</div>')
  assert.equal(calls.includes('client_ready'), false)
  dom.window.document.getElementById('root').innerHTML = '<main data-verboo-shell>workspace</main>'
  await ready
  assert.equal(calls.filter(command => command === 'client_ready').length, 1)
})

test('does not report successful product startup for a generic mounted root', async (t) => {
  const { calls } = page(t, '<main>upstream workspace</main>')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(calls.includes('client_ready'), false)
})

test('opens allowlisted destinations in the system browser and rejects embedded or script protocols', async (t) => {
  const { dom, requests } = page(t, '<main>workspace</main>')
  for (const url of [
    'https://code.verboo.ai/oauth/authorize?state=fixture',
    'http://intranet.example.invalid/wiki',
    'mailto:dev@example.com',
    'tel:+5511999999999',
  ]) {
    await dom.window.__VERBOO_DESKTOP__.openExternal(url)
    assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1))), { command: 'plugin:opener|open_url', args: { url, with: null } })
  }
  for (const url of [
    'file:///private/fixture', 'javascript:void(0)', 'data:text/html,<b>x</b>', 'ftp://example.invalid/x',
    'https://user:password@code.verboo.ai', 'verboo://open',
  ]) {
    await assert.rejects(dom.window.__VERBOO_DESKTOP__.openExternal(url))
  }
})

test('hands a completed quit hold to the native shutdown owner', async (t) => {
  const { dom, calls } = page(t, '<main>workspace</main>')
  await dom.window.__VERBOO_DESKTOP__.quit()
  assert.equal(calls.filter(command => command === 'quit_after_hold').length, 1)
  const permissions = await readFile(new URL('../../src-tauri/permissions/desktop.toml', import.meta.url), 'utf8')
  const allowed = JSON.parse(permissions.match(/^commands\.allow = (.+)$/m)[1])
  assert.ok(allowed.includes('quit_after_hold'), 'native ACL must allow the completed gesture')
})

test('exposes validated update snapshots, subscribes to changes and unregisters', async (t) => {
  const { dom, requests } = page(t, '<main>workspace</main>')
  const originalInvoke = dom.window.__TAURI_INTERNALS__.invoke
  dom.window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'update_snapshot'
    ? Promise.resolve({ phase: 'downloading', percent: 25 })
    : originalInvoke(command, args)
  const updates = dom.window.__VERBOO_UPDATE__
  assert.equal(dom.window.__VERBOO_DESKTOP__.updates, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(await updates.getState())), { phase: 'downloading', percent: 25 })
  const seen = []
  const unsubscribe = updates.subscribe(state => seen.push(JSON.parse(JSON.stringify(state))))
  dom.window.dispatchEvent(new dom.window.CustomEvent('verboo-update-state', { detail: { phase: 'checking', percent: null } }))
  dom.window.dispatchEvent(new dom.window.CustomEvent('verboo-update-state', { detail: { phase: 'ready', percent: 100 } }))
  dom.window.dispatchEvent(new dom.window.CustomEvent('verboo-update-state', { detail: { phase: 'ready', percent: 101 } }))
  dom.window.dispatchEvent(new dom.window.CustomEvent('verboo-update-state', { detail: { phase: 'unknown', percent: null } }))
  unsubscribe()
  dom.window.dispatchEvent(new dom.window.CustomEvent('verboo-update-state', { detail: { phase: 'idle', percent: null } }))
  assert.deepEqual(seen, [{ phase: 'checking', percent: null }, { phase: 'ready', percent: 100 }])
  await updates.install(false)
  assert.equal(requests.at(-1).command, 'update_restart')
  assert.equal(requests.at(-1).args.confirmed, false)
  await updates.install(true)
  assert.equal(requests.at(-1).args.confirmed, true)
  await updates.retry()
  assert.equal(requests.at(-1).command, 'update_retry')
  const permissions = await readFile(new URL('../../src-tauri/permissions/desktop.toml', import.meta.url), 'utf8')
  const allowed = JSON.parse(permissions.match(/^commands\.allow = (.+)$/m)[1])
  assert.ok(allowed.includes('update_snapshot'))
  assert.ok(allowed.includes('update_restart'))
  assert.ok(allowed.includes('update_retry'))
  assert.ok(allowed.includes('desktop_layout_read'))
  assert.ok(allowed.includes('desktop_layout_write'))
})

test('rejects malformed native update snapshots', async (t) => {
  const { dom } = page(t, '<main>workspace</main>')
  dom.window.__TAURI_INTERNALS__.invoke = () => Promise.resolve({ phase: 'ready', percent: -1 })
  await assert.rejects(dom.window.__VERBOO_UPDATE__.getState(), /desktop_update_state_invalid/)
})

test('native diagnostics contain asset coordinates and never error-message contents', async (t) => {
  const { dom, requests } = page(t, '<main>workspace</main>')
  const error = new dom.window.Error('fixture-private-account@example.invalid fixture-private-token')
  error.stack = 'Error: fixture-private-token\n at http://127.0.0.1:43128/assets/fixture.js:2:3'
  dom.window.console.error(error)
  dom.window.console.error(error)
  const diagnostics = requests.filter(request => request.command === 'client_diagnostic')
  assert.equal(diagnostics.length, 1)
  const args = JSON.parse(JSON.stringify(diagnostics[0].args))
  assert.deepEqual(args, { frames: [{ asset: '/assets/fixture.js', line: 2, column: 3 }], entries: [] })
  assert.equal(JSON.stringify(args).includes('private'), false)
})

test('restores only desktop layout keys and mirrors changes across loopback origins', async (t) => {
  const saved = { 'dsh.verboo.layout.v1': '{"sidebar":0}', 'dsh.sidebar-right.v1.session': '{"bySession":{}}' }
  const make = port => {
    const dom = new JSDOM('<div id="root"></div>', { url: `http://127.0.0.1:${port}/`, runScripts: 'outside-only' })
    t.after(() => dom.window.close())
    dom.window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'desktop_layout_read') return { ...saved }
      if (command === 'desktop_layout_write') {
        if (args.value === null) delete saved[args.key]
        else saved[args.key] = args.value
      }
      return null
    } }
    dom.window.eval(source)
    return dom.window
  }
  const first = make(31001)
  await first.__VERBOO_LAYOUT_STORAGE__.ready
  assert.equal(first.localStorage.getItem('dsh.verboo.layout.v1'), '{"sidebar":0}')
  first.localStorage.setItem('dsh.terminal.shell', '/bin/bash')
  first.localStorage.setItem('unrelated.secret', 'not-persisted')
  await new Promise(resolve => setTimeout(resolve, 0))
  const second = make(31002)
  await second.__VERBOO_LAYOUT_STORAGE__.ready
  assert.equal(second.localStorage.getItem('dsh.terminal.shell'), '/bin/bash')
  assert.equal(second.localStorage.getItem('unrelated.secret'), null)
  second.localStorage.removeItem('dsh.sidebar-right.v1.session')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(saved['dsh.sidebar-right.v1.session'], undefined)
})

test('does not overwrite saved layout when desktop hydration fails', async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:43129/', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const calls = []
  dom.window.__TAURI_INTERNALS__ = { invoke(command) {
    calls.push(command)
    return command === 'desktop_layout_read' ? Promise.reject(new Error('fixture')) : Promise.resolve()
  } }
  dom.window.eval(source)
  await dom.window.__VERBOO_LAYOUT_STORAGE__.ready
  dom.window.localStorage.setItem('dsh.verboo.layout.v1', '{"sidebar":0}')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(calls.includes('desktop_layout_write'), false)
})

test('bounds startup when desktop layout storage never answers', { timeout: 4000 }, async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:43130/', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const calls = []
  dom.window.__TAURI_INTERNALS__ = { invoke(command) {
    calls.push(command)
    return command === 'desktop_layout_read' ? new Promise(() => {}) : Promise.resolve()
  } }
  dom.window.eval(source)
  await dom.window.__VERBOO_LAYOUT_STORAGE__.ready
  dom.window.localStorage.setItem('dsh.verboo.layout.v1', '{"sidebar":0}')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(calls.includes('desktop_layout_write'), false)
})

test('buffers a native quit request until the dialog subscribes and returns its decision', async (t) => {
  const { dom, requests } = page(t, '<main>workspace</main>')
  const bridge = dom.window.__VERBOO_QUIT_CONFIRMATION__
  dom.window.dispatchEvent(new dom.window.Event('verboo-quit-confirmation'))
  let count = 0
  const unsubscribe = bridge.subscribe(() => { count++ })
  assert.equal(count, 1)
  await bridge.respond(false)
  assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1))), { command: 'quit_confirmation_response', args: { confirmed: false } })
  unsubscribe()
  bridge.subscribe(() => { count++ })()
  assert.equal(count, 1)
})

test('diagnostics include only safe names from a client boot audit', (t) => {
  const { dom, requests } = page(t, '<main>workspace</main>')
  const error = new dom.window.Error('web boot: 1 required entry did not activate\n@deepseek-ai/dsh-client-ui (required): failed: private-token\nnot-a-plugin: private-token')
  dom.window.console.error(error)
  const diagnostic = requests.find(request => request.command === 'client_diagnostic')
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic.args.entries)), ['@deepseek-ai/dsh-client-ui'])
  assert.equal(JSON.stringify(diagnostic.args).includes('private-token'), false)
})
