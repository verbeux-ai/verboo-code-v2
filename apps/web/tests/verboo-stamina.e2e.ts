/** Built Verboo composition with a borrowed recorded Session and a loopback-only product API. */
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
const OTHER_PLAN = '00000000-0000-4000-8000-000000000004'
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const EXPECTED = join(ROOT, 'apps/web/tests/expected/verboo-stamina')
const MODE = webSnapshotMode()
const DEBUG = process.env.VERBOO_STAMINA_DEBUG_QA === '1'
const ARTIFACTS = process.env.STAMINA_QA_DIR ?? join(tmpdir(), 'verboo-stamina-v2-qa')

async function platformFixture() {
  const state = {
    enrolled: true, down: false, holdNext: false, reads: 0, includeOther: false, omitSelected: false,
    level: undefined as number | undefined, held: undefined as (() => void) | undefined,
  }
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
        groupId: PLAN, groupName: 'Unlimited', remainingPercent: state.level ?? (account === ACCOUNT_A ? 50 : 100),
        nextOutputTps: account === ACCOUNT_A ? 67 : 200, recovering: false, fullAt: null,
        accountingPending: false, asOf: new Date().toISOString(),
      }
      const readings = state.enrolled ? [
        ...state.omitSelected ? [] : [row],
        ...state.includeOther ? [{ ...row, groupId: OTHER_PLAN, groupName: 'Testes', remainingPercent: 7.75 }] : [],
      ] : []
      const reply = () => { respond(res, state.down ? 503 : 200, state.down ? { error: 'unavailable' } : { data: readings }) }
      if (state.holdNext) {
        state.holdNext = false
        state.held = reply
      } else reply()
      return
    }
    if (req.url === '/api/me/subscriptions') {
      respond(res, 200, { data: [
        { id: PLAN, groupId: PLAN, group: { name: 'Unlimited', slug: 'unlimited' }, status: 'active', cancelAtPeriodEnd: false, management: { changePlan: false }, billing: null },
        { id: OTHER_PLAN, groupId: OTHER_PLAN, group: { name: 'Testes', slug: 'testes' }, status: 'active', cancelAtPeriodEnd: false, management: { changePlan: false }, billing: null },
      ] })
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
  async function openConversation() {
    await navigate(/^(Workspace|Área de trabalho)$/)
    await page.locator('[data-verboo-session="stamina-history"]').getByRole('button').first().click()
  }
  async function chooseModel(name: string) {
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name, exact: true }).click()
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
- id: agent-default-model
  config:
    provider: deepseek-account
    model: unlimited/deepseek-v4-flash
- insert:
    - id: stamina-fixture-account
      name: ${JSON.stringify(fileURLToPath(new URL('./fixtures/verboo-stamina/account.mjs', import.meta.url)))}
      config:
        accountId: ${ACCOUNT_A}
        apiOrigin: ${JSON.stringify(platform.origin)}
`)
    scaffold = await launchWebScaffold({
      profile: { hmr: false, packages: [{ dir: join(ROOT, 'packages/bundle/verboo-app'), enabled: true }] },
      welcomeNoticePending: true,
      replayFixture: join(ROOT, 'apps/web/tests/fixtures/model-badge/session.v4.jsonl'),
      replayProvidersOnly: true,
      replayProviders: [{
        id: 'deepseek-account', name: 'Verboo Code fixture', models: [
          { id: 'unlimited/deepseek-v4-flash', name: 'Fixture model', contextWindow: 128000 },
          { id: 'testes/deepseek-v4-flash', name: 'Testes model', contextWindow: 128000 },
        ],
      }, {
        id: 'deepseek-official', name: 'Recorded fixture provider',
        models: [{ id: 'deepseek-v4-flash', name: 'Recorded fixture model', contextWindow: 128000 }],
      }],
      extraOverlayPath: [join(ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml'), overlay],
    })
    const session = await selectedSessionFixture(join(ROOT, 'snapshots/web/turn-tail-actions/session.v4.jsonl'))
    await seedSession(scaffold, await readFile(session, 'utf8'), 'stamina-history')
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {})
    page = await browser.newPage({ viewport: { width: 1280, height: 960 }, locale: 'en-US' })
    page.setDefaultTimeout(10000)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-verboo-onboarding]').waitFor({ state: 'hidden' })
    if (DEBUG) {
      await page.getByRole('button', { name: /^(Preferences|Preferências)$/ }).click()
      await page.getByRole('checkbox', { name: 'Stamina (debug)' }).click()
      await page.waitForFunction(() => {
        const input = document.querySelector<HTMLInputElement>('input[type=checkbox]')
        return input?.checked && !input.disabled
      })
    }
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
      expect(await region.textContent()).not.toMatch(/tok\/s|tokens\/s|t\/s|词元\/秒/i)
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
  it('surrounds Send with a purple ring while retaining the water inside', async () => {
    await navigate(/^(Preferences|Preferências)$/)
    await page.getByLabel(/^(Language|Idioma)$/).selectOption('en')
    await openConversation()
    await chooseModel('Fixture model')
    const primary = page.locator('[data-composer-primary]')
    const liquid = primary.locator('[data-verboo-stamina-liquid]')
    const ring = primary.locator('[data-stamina-ring]')
    const model = page.locator('[data-slot="conversation.input.model"] button[aria-haspopup="menu"]').first()
    const editor = page.locator('[data-composer-card]').getByRole('textbox')
    await liquid.waitFor()
    expect(await primary.getAttribute('aria-label')).toBe('Send message')
    expect(await primary.isDisabled()).toBe(true)
    expect(await page.locator('[data-slot="conversation.input.right"] [data-verboo-stamina]').count()).toBe(0)
    expect(await primary.textContent()).toBe('')
    expect(await page.locator('[data-verboo-stamina-debug]').count()).toBe(DEBUG ? 1 : 0)
    await compareOrRefreshGolden(join(EXPECTED, 'composer.expected.md'), await captureStableAria(page, '[data-composer-primary]', scaffold.workspaceCwd), MODE)
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
        const button = await primary.boundingBox()
        const water = await liquid.boundingBox()
        const outline = await ring.boundingBox()
        const selector = await model.boundingBox()
        return button !== null && water !== null && outline !== null && selector !== null
          && button.width === 42 && button.height === 42
          && water.width === 34 && water.height === 34
          && outline.width === 42 && outline.height === 42
          && selector.x + selector.width <= button.x
          && button.x + button.width <= width && button.y + button.height <= 960
      }).toBe(true)
      expect(await ring.evaluate(node => parseFloat(getComputedStyle(node).borderTopWidth))).toBeGreaterThanOrEqual(1)
      expect(await primary.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await liquid.locator('[data-stamina-water]').evaluate(node => (node as HTMLElement).style.height)).toBe('50%')
      await editor.fill('Unsent ring fixture draft')
      await page.keyboard.press('Tab')
      await primary.focus()
      expect(await primary.evaluate(node => node.matches(':focus-visible'))).toBe(true)
      await editor.fill('')
      await primary.screenshot({ path: join(ARTIFACTS, `send-ring-${width}.png`), animations: 'disabled' })
      await page.locator('[data-composer-card]').screenshot({ path: join(ARTIFACTS, `composer-ring-${width}.png`), animations: 'disabled' })
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
    expect(await region.textContent()).not.toMatch(/tok\/s|tokens\/s|t\/s|词元\/秒/i)
  })
  it.skipIf(!DEBUG)('shows exact server percentages and fresh timestamps in debug mode', async () => {
    await openConversation()
    await chooseModel('Fixture model')
    const debug = page.locator('[data-verboo-stamina-debug]')
    await debug.waitFor()
    try {
      platform.state.level = 99.9987654321
      await expect.poll(() => debug.textContent(), { timeout: 10000 }).toContain('99.9987654321%')
      const previous = await debug.locator('time').first().getAttribute('datetime')
      await debug.getByRole('button', { name: /^(Refresh|Atualizar)$/ }).click()
      await expect.poll(() => debug.locator('time').first().getAttribute('datetime'), { timeout: 10000 }).not.toBe(previous)
      platform.state.level = 25.125
      await expect.poll(() => debug.textContent(), { timeout: 10000 }).toContain('25.125%')
      expect(await debug.textContent()).not.toMatch(/tok\/s|tokens\/s|\bTPS\b/)
      const liquid = page.locator('[data-verboo-stamina-liquid]')
      await expect.poll(async () => {
        const water = await liquid.locator('[data-stamina-water]').boundingBox()
        const circle = await liquid.boundingBox()
        return water!.height / circle!.height
      }).toBeCloseTo(0.25125, 2)
      await page.screenshot({ path: join(ARTIFACTS, 'debug-server-reading.png'), animations: 'disabled' })
      await page.setViewportSize({ width: 390, height: 960 })
      await page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').waitFor({ state: 'attached' })
      const debugBox = await debug.boundingBox()
      expect(debugBox!.x).toBeGreaterThanOrEqual(0)
      expect(debugBox!.x + debugBox!.width).toBeLessThanOrEqual(390)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: join(ARTIFACTS, 'debug-server-reading-compact.png'), animations: 'disabled' })
      await navigate(/^(Preferences|Preferências)$/)
      const toggle = page.getByRole('checkbox', { name: 'Stamina (debug)' })
      await toggle.click()
      await expect.poll(() => toggle.isChecked(), { timeout: 5000 }).toBe(false)
      await page.reload({ waitUntil: 'load' })
      await navigate(/^(Preferences|Preferências)$/)
      await expect.poll(() => toggle.isChecked(), { timeout: 5000 }).toBe(false)
      await toggle.click()
      await expect.poll(() => toggle.isChecked(), { timeout: 5000 }).toBe(true)
    } finally {
      platform.state.level = undefined
    }
  })

  it.skipIf(!DEBUG)('follows the selected group and never borrows another group’s stamina', async () => {
    await openConversation()
    await chooseModel('Fixture model')
    const debug = page.locator('[data-verboo-stamina-debug]')
    const liquid = page.locator('[data-verboo-stamina-liquid]')
    const previousLevel = platform.state.level
    try {
      platform.state.level = 50
      platform.state.includeOther = true
      await debug.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect.poll(() => debug.textContent(), { timeout: 10000 }).toContain('Unlimited: 50%')
      expect(await debug.textContent()).not.toContain('Testes')
      await chooseModel('Testes model')
      await expect.poll(() => debug.textContent(), { timeout: 10000 }).toContain('Testes: 7.75%')
      expect(await debug.textContent()).not.toContain('Unlimited')
      await expect.poll(() => liquid.locator('[data-stamina-water]').evaluate(node => (node as HTMLElement).style.height)).toBe('7.75%')
      await chooseModel('Fixture model')
      await expect.poll(() => debug.textContent(), { timeout: 10000 }).toContain('Unlimited: 50%')
      platform.state.omitSelected = true
      await debug.getByRole('button', { name: 'Refresh', exact: true }).click()
      await expect.poll(() => debug.textContent(), { timeout: 10000 }).toContain('Unlimited: no stamina reading for this group')
      expect(await debug.textContent()).not.toContain('Testes')
      expect(await debug.textContent()).not.toContain('%')
      expect(await liquid.count()).toBe(0)
      await page.screenshot({ path: join(ARTIFACTS, 'selected-group-unavailable.png'), animations: 'disabled' })
    } finally {
      platform.state.includeOther = false
      platform.state.omitSelected = false
      platform.state.level = previousLevel
    }
  })

})
