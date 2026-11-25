/** Built workspace chrome with a controlled native update carrier. */
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchWebScaffold, watchConsole } from './scaffold.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
type Presentation = { phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'; version?: string; percent?: number }
interface CarrierFixture {
  publish(state: Presentation): void
  restarts: number
  dismissed: string[]
  listeners: Set<(state: Presentation) => void>
}
type FixtureWindow = Window & typeof globalThis & { updateFixture: CarrierFixture }

describe('web e2e: Desktop update workspace chrome', () => {
  it.each(['zh-CN', 'en-US'])('reports progress and confirms a staged restart in %s', async (locale) => {
    const directory = await mkdtemp(join(tmpdir(), 'verboo-updates-'))
    const platform = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [] }))
    })
    await new Promise<void>(resolve => platform.listen(0, '127.0.0.1', resolve))
    const address = platform.address()
    if (address === null || typeof address === 'string') throw new Error('Loopback API did not start')
    const origin = `http://127.0.0.1:${address.port}`
    const overlay = join(directory, 'updates.patch.yml')
    await writeFile(overlay, `- id: verboo-account
  disabled: true
- id: verboo-product
  config:
    apiOrigin: ${JSON.stringify(origin)}
    routerBaseURL: ${JSON.stringify(origin + '/router/v1')}
    allowLoopbackHttp: true
- insert:
    - id: updates-fixture-account
      name: ${JSON.stringify(fileURLToPath(new URL('./fixtures/verboo-stamina/account.mjs', import.meta.url)))}
      config:
        accountId: 00000000-0000-4000-8000-000000000002
        apiOrigin: ${JSON.stringify(origin)}
`)
    const scaffold = await launchWebScaffold({
      profile: { hmr: false, packages: [{ dir: join(ROOT, 'packages/bundle/verboo-app'), enabled: true }] },
      welcomeNoticePending: true,
      extraOverlayPath: [overlay],
    })
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale })
        await page.addInitScript(() => {
          let current: Presentation = { phase: 'idle' }
          const listeners = new Set<(state: Presentation) => void>()
          const fixture: CarrierFixture = {
            restarts: 0, dismissed: [], listeners,
            publish(state) { current = state; for (const listener of listeners) listener(state) },
          }
          Object.assign(window, {
            updateFixture: fixture,
            __VERBOO_DESKTOP__: { protocolVersion: 1, updates: {
              status: async () => current,
              restart: async () => { fixture.restarts += 1 },
              dismiss: async (version: string) => { fixture.dismissed.push(version) },
              subscribe(listener: (state: Presentation) => void) { listeners.add(listener); return () => listeners.delete(listener) },
            } },
          })
        })
        const tripwire = watchConsole(page)
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await page.locator('[data-verboo-onboarding]').waitFor({ state: 'hidden' })
        await expect.poll(() => page.evaluate(() => (window as FixtureWindow).updateFixture.listeners.size)).toBe(1)
        const publish = (state: Presentation) => page.evaluate(value => (window as FixtureWindow).updateFixture.publish(value), state)
        const restarts = () => page.evaluate(() => (window as FixtureWindow).updateFixture.restarts)
        const version = '0.2.2-alpha.37'

        await publish({ phase: 'downloading', version, percent: 58 })
        const progress = page.getByRole('button', { name: '58%', exact: true })
        await progress.waitFor()
        expect(await progress.getAttribute('aria-disabled')).toBe('true')
        await progress.click({ force: true })
        expect(await restarts()).toBe(0)

        await publish({ phase: 'ready', version })
        const ready = page.getByRole('button', { name: locale === 'zh-CN' ? /更新已就绪/ : /Update ready/ })
        await ready.waitFor()
        await ready.click()
        const dialog = page.getByRole('dialog', { name: locale === 'zh-CN' ? '重启以完成更新？' : 'Restart to finish updating?' })
        await dialog.waitFor()
        expect(await restarts()).toBe(0)
        await dialog.getByRole('button', { name: locale === 'zh-CN' ? '立即重启' : 'Restart now', exact: true }).click()
        await expect.poll(restarts).toBe(1)

        await publish({ phase: 'error', version })
        await page.getByRole('button', { name: locale === 'zh-CN' ? '重试更新' : 'Retry update', exact: true }).click()
        await expect.poll(() => page.evaluate(() => (window as FixtureWindow).updateFixture.dismissed)).toEqual([version])
        expect(tripwire.pageErrors).toEqual([])
      } finally { await browser.close() }
    } finally {
      await scaffold.close()
      await new Promise<void>(resolve => platform.close(() => { resolve() }))
      await rm(directory, { recursive: true, force: true })
    }
  })
})
