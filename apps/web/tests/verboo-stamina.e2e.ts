/** Built Verboo composition with a borrowed recorded Session and a loopback-only product API. */
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  selectedSessionFixture, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'

const ACCOUNT_A = '00000000-0000-4000-8000-000000000002'
const ACCOUNT_B = '00000000-0000-4000-8000-000000000003'
const PLAN = '00000000-0000-4000-8000-000000000001'
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const EXPECTED = join(ROOT, 'apps/web/tests/expected/verboo-stamina')
const MODE = webSnapshotMode()
const ARTIFACTS = process.env.STAMINA_QA_DIR ?? join(tmpdir(), 'verboo-stamina-v2-qa')

async function platformFixture() {
  const state = { enrolled: true, down: false, holdNext: false, reads: 0, held: undefined as (() => void) | undefined }
  const respond = (res: ServerResponse, status: number, body: unknown) => {
    if (res.destroyed) return
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }
  const server = createServer((req, res) => {
    const account = req.headers.authorization?.replace('Bearer stamina-fixture:', '')
    if (account !== ACCOUNT_A && account !== ACCOUNT_B) {
      respond(res, 401, { error: 'unauthorized' })
      return
    }
    if (req.url === '/api/me/stamina') {
      state.reads++
      const row = {
        groupId: PLAN, groupName: 'Unlimited', remainingPercent: account === ACCOUNT_A ? 50 : 100,
        nextOutputTps: account === ACCOUNT_A ? 67 : 200, recovering: false, fullAt: null,
        accountingPending: false, asOf: new Date().toISOString(),
      }
      const reply = () => { respond(res, state.down ? 503 : 200, state.down ? { error: 'unavailable' } : { data: state.enrolled ? [row] : [] }) }
      if (state.holdNext) {
        state.holdNext = false
        state.held = reply
      } else reply()
      return
    }
    if (req.url === '/api/me/subscriptions') {
      respond(res, 200, { data: [{ id: PLAN, groupId: PLAN, group: { name: 'Unlimited' }, status: 'active', cancelAtPeriodEnd: false, management: { changePlan: false }, billing: null }] })
      return
    }
    if (req.url?.startsWith('/api/marketplace')) {
      respond(res, 200, { data: [] })
      return
    }
    if (req.url === '/api/me/connections?catalog=all') {
      respond(res, 200, { data: { available: false, toolkits: [], accounts: [] } })
      return
    }
    respond(res, 404, { error: 'not_found' })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Loopback API did not start')
  return {
    state, origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      state.held?.()
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeAllConnections()
    }),
  }
}

describe.skipIf(MODE === 'record')('Verboo stamina in the built application', () => {
  let platform: Awaited<ReturnType<typeof platformFixture>>
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let directory: string
  let failures = 0
  async function navigate(name: RegExp) {
    await page.setViewportSize({ width: 1280, height: 960 })
    await expect.poll(() => page.locator('[data-sidebar-drawer]').count()).toBe(0)
    const button = page.getByRole('button', { name }).first()
    await button.click()
  }
  beforeAll(async () => {
    platform = await platformFixture()
    directory = await mkdtemp(join(tmpdir(), 'verboo-stamina-browser-'))
    await mkdir(ARTIFACTS, { recursive: true })
    if (MODE === 'refresh') await mkdir(EXPECTED, { recursive: true })
    const overlay = join(directory, 'stamina.patch.yml')
    await writeFile(overlay, `- id: verboo-account
  disabled: true
- id: verboo-product
  config:
    apiOrigin: ${JSON.stringify(platform.origin)}
    routerBaseURL: ${JSON.stringify(platform.origin + '/router/v1')}
    allowLoopbackHttp: true
- id: ui-verboo
  config:
    staminaRefreshIntervalMs: 1000
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
- insert:
    - id: stamina-fixture-account
      name: ${JSON.stringify(fileURLToPath(new URL('./fixtures/verboo-stamina/account.mjs', import.meta.url)))}
      config:
        accountId: ${ACCOUNT_A}
        apiOrigin: ${JSON.stringify(platform.origin)}
`)
    scaffold = await launchWebScaffold({
      profile: { hmr: false, packages: [] },
      welcomeNoticePending: true,
      replayFixture: join(ROOT, 'apps/web/tests/fixtures/model-badge/session.v4.jsonl'),
      replayProvidersOnly: true,
      replayProviders: ['deepseek-account', 'deepseek-official'].map(id => ({
        id, name: 'Verboo Code fixture', models: [{ id: 'deepseek-v4-flash', name: 'Fixture model', contextWindow: 128000 }],
      })),
      extraOverlayPath: [join(ROOT, 'packages/bundle/verboo-app/cordis.patch.yml'), join(ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml'), overlay],
      extraInstallAnchors: [join(ROOT, 'packages/bundle/verboo-app/package.json')],
    })
    const session = await selectedSessionFixture(join(ROOT, 'snapshots/web/turn-tail-actions/session.v4.jsonl'))
    await seedSession(scaffold, await readFile(session, 'utf8'), 'stamina-history')
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {})
    page = await browser.newPage({ viewport: { width: 1280, height: 960 }, locale: 'en-US' })
    page.setDefaultTimeout(10000)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-verboo-onboarding]').waitFor({ state: 'hidden' })
  }, 120000)
  afterEach(async ({ task }) => {
    if (task.result?.state !== 'fail' || !page) return
    const path = join(ARTIFACTS, `failure-${++failures}`)
    await page.screenshot({ path: `${path}.png` })
    await writeFile(`${path}.aria.txt`, await page.locator('body').ariaSnapshot())
  })
  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await platform?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('shows the server reading in My plan across languages, themes and viewport sizes', async () => {
    for (const locale of ['en', 'pt']) {
      await navigate(/^(Preferences|Preferências)$/)
      await page.getByLabel(/^(Language|Idioma)$/).selectOption(locale)
      await navigate(/^(My plan|Meu plano)$/)
      const region = page.locator('[data-verboo-page="plan"] [data-verboo-stamina]')
      await region.getByRole('progressbar').waitFor()
      expect(await region.getByRole('progressbar').getAttribute('value')).toBe('50')
      await compareOrRefreshGolden(join(EXPECTED, `plan-${locale}.expected.md`), await captureStableAria(page, '[data-verboo-page="plan"] [data-verboo-stamina]', scaffold.workspaceCwd), MODE)
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 960 })
          await region.scrollIntoViewIfNeeded()
          const box = await region.boundingBox()
          expect(box).not.toBeNull()
          expect(box!.x).toBeGreaterThanOrEqual(0)
          expect(box!.x + box!.width).toBeLessThanOrEqual(width)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await page.screenshot({ path: join(ARTIFACTS, `plan-${locale}-${theme}-${width}.png`), animations: 'disabled' })
        }
      }
    }
  })
  it('places a horizontal stamina bar immediately before the model selector', async () => {
    await page.setViewportSize({ width: 1280, height: 960 })
    await navigate(/^(Workspace|Área de trabalho)$/)
    await page.getByRole('button').filter({ has: page.getByText(basename(scaffold.workspaceCwd), { exact: true }) }).click()
    const meter = page.getByRole('meter', { name: /^(Stamina|耐力)$/ })
    const liquid = meter.locator('[data-verboo-stamina-liquid]')
    const model = page.locator('[data-slot="conversation.input.model"] button[aria-haspopup="menu"]').first()
    const primary = page.getByRole('button', { name: /^(Send message|Enviar mensagem)$/ })
    await meter.waitFor()
    expect(await liquid.isVisible()).toBe(true)
    const bar = await liquid.boundingBox()
    expect(bar!.width).toBeGreaterThanOrEqual(bar!.height * 4)
    expect(bar!.height).toBeLessThanOrEqual(12)
    expect(await meter.getAttribute('aria-valuenow')).toBe('50')
    expect(await meter.textContent()).toBe('')
    expect(await primary.locator('[data-verboo-stamina-liquid]').count()).toBe(0)
    expect(await page.locator('[data-composer-dock] [data-verboo-stamina]').count()).toBe(0)
    await compareOrRefreshGolden(join(EXPECTED, 'composer.expected.md'), await captureStableAria(page, '[data-verboo-stamina][role="meter"]', scaffold.workspaceCwd), MODE)
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 960 })
      if (width === 390) {
        const drawer = page.locator('[data-sidebar-drawer]')
        await drawer.waitFor()
        if (await drawer.getAttribute('data-sidebar-collapsed') !== 'true') {
          await page.getByRole('button', { name: /^(Collapse navigation|Recolher navegação|Collapse sidebar|Recolher barra lateral)$/ }).first().click()
        }
        await page.locator('[data-sidebar-drawer][data-sidebar-collapsed=true]').waitFor()
      }
      await expect.poll(async () => {
        const bounds = await meter.boundingBox()
        const selector = await model.boundingBox()
        const send = await primary.boundingBox()
        return bounds !== null && selector !== null && send !== null
          && bounds.x >= 0 && bounds.y + bounds.height <= 960
          && bounds.x + bounds.width <= selector.x
          && selector.x + selector.width <= send.x
          && send.x + send.width <= width
          && Math.abs(bounds.y + bounds.height / 2 - selector.y - selector.height / 2) <= 1
      }).toBe(true)
      expect(await meter.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await meter.hover()
      const tooltip = page.getByRole('tooltip')
      await tooltip.waitFor()
      expect(await tooltip.textContent()).toBe('Stamina')
      const tip = await tooltip.boundingBox()
      expect(tip!.x).toBeGreaterThanOrEqual(0)
      expect(tip!.x + tip!.width).toBeLessThanOrEqual(width)
      expect(await tooltip.evaluate(node => node.closest('[data-composer-card]') === null)).toBe(true)
      await page.keyboard.press('Escape')
      await tooltip.waitFor({ state: 'hidden' })
      await page.locator('[data-composer-card]').screenshot({ path: join(ARTIFACTS, `composer-bar-${width}.png`), animations: 'disabled' })
      await page.screenshot({ path: join(ARTIFACTS, `composer-${width}.png`), animations: 'disabled' })
    }
    await navigate(/^(My plan|Meu plano)$/)
  })
  it('preserves the confirmed bar during failure, recovers, and hides an unselected account', async () => {
    const region = page.locator('[data-verboo-page="plan"] [data-verboo-stamina]')
    platform.state.down = true
    await region.getByRole('status').waitFor()
    expect(await region.getByRole('progressbar').getAttribute('value')).toBe('50')
    platform.state.down = false
    await region.getByRole('button', { name: /^(Try again|Tentar novamente)$/ }).click()
    await region.getByRole('status').waitFor({ state: 'hidden' })
    platform.state.enrolled = false
    await region.waitFor({ state: 'hidden' })
    expect(await page.getByRole('progressbar').count()).toBe(0)
    platform.state.enrolled = true
    await region.getByRole('progressbar').waitFor()
    expect(await region.getByRole('progressbar').getAttribute('value')).toBe('50')
  })
  it('discards the old account response while switching to another selected account', async () => {
    platform.state.holdNext = true
    await page.getByRole('button', { name: /^(Refresh|Atualizar)$/ }).first().click()
    await expect.poll(() => platform.state.held !== undefined).toBe(true)
    const account = scaffold.ctx.deepseekAccount
    if (!('setFixtureAccount' in account) || typeof account.setFixtureAccount !== 'function') throw new Error('Fixture account control is unavailable')
    Reflect.apply(account.setFixtureAccount, account, [ACCOUNT_B])
    const region = page.locator('[data-verboo-page="plan"] [data-verboo-stamina]')
    await expect.poll(() => region.getByRole('progressbar').getAttribute('value')).toBe('100')
    platform.state.held!()
    await expect.poll(() => region.getByRole('progressbar').getAttribute('value')).toBe('100')
    expect(await region.textContent()).toContain('200 tok/s')
    expect(await region.textContent()).not.toContain('67 tok/s')
  })
})
