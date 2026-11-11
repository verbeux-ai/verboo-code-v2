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
