import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const html = await readFile(new URL('../ui/startup-error.html', import.meta.url), 'utf8')
const script = await readFile(new URL('../ui/startup-error.js', import.meta.url), 'utf8')

function render(t, state) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  Object.defineProperty(dom.window.navigator, 'language', { value: 'pt-BR' })
  const requests = []
  dom.window.__VERBOO_STARTUP_ERROR__ = state
  dom.window.__TAURI_INTERNALS__ = { invoke: command => { requests.push(command); return Promise.resolve() } }
  dom.window.eval(script)
  return { document: dom.window.document, requests }
}

test('shows only relevant guidance and retries a safely stopped startup', t => {
  const { document, requests } = render(t, { code: 'runtime_artifact_missing', canRetry: true })
  assert.match(document.querySelector('#title').textContent, /Não foi possível iniciar/)
  assert.equal(document.querySelector('#guidance').hidden, false)
  assert.match(document.querySelector('#guidance-text').textContent, /instalador oficial/)
  document.querySelector('#retry').click()
  assert.deepEqual(requests, ['startup_retry'])
  assert.equal(document.querySelector('#retry').disabled, true)
})

test('unknown failures expose a safe code without guessed guidance', t => {
  const { document } = render(t, { code: '<private path or token>', canRetry: true })
  assert.equal(document.querySelector('#code').textContent, 'startup_failed')
  assert.equal(document.querySelector('#guidance').hidden, true)
  assert.doesNotMatch(document.body.textContent, /private path or token/)
})

test('does not offer retry when safe Host shutdown is unconfirmed', t => {
  const { document } = render(t, { code: 'host_disconnected', canRetry: false })
  assert.equal(document.querySelector('#retry').hidden, true)
  assert.match(document.querySelector('#description').textContent, /segurança/)
})
