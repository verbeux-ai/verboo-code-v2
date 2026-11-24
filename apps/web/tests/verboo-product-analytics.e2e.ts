/** Real Verboo web composition and Host collector, with a loopback-only API. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-host-verboo-analytics'
import { launchWebScaffold, seedSession, selectedSessionFixture } from './scaffold.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ACCOUNT = '00000000-0000-4000-8000-000000000002'

it('sends anonymous, bounded observations for actual project and split controls', async () => {
  const events: Record<string, unknown>[] = []
  const installationHeaders = new Set<string>()
  const fixtureErrors: unknown[] = []
  const requests: string[] = []
  let order = 100
  const server = createServer((req, res) => {
    void (async () => {
      requests.push(`${req.method ?? ''} ${req.url ?? ''}`)
      let body = ''
      for await (const part of req) body += String(part)
      res.setHeader('content-type', 'application/json')
      const respond = (status: number, payload: unknown) => { res.writeHead(status).end(JSON.stringify(payload)) }
      if (req.url === '/api/analytics/product-consent') {
        const serverOrder = String(++order)
        respond(200, { data: { subjectId: 'a'.repeat(64), decision: 'granted', revision: 1, policyVersion: 1,
          decisionOrder: '1', decidedAt: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', enabled: true,
          serverTime: new Date().toISOString(), serverOrder, serverProof: `v1.${serverOrder}.${'b'.repeat(64)}` } })
        return
      }
      if (req.url === '/api/analytics/product-events') {
        const event = JSON.parse(body) as Record<string, unknown>
        events.push(event)
        installationHeaders.add(String(req.headers['x-verboo-analytics-installation'] ?? ''))
        respond(202, { data: { status: 'accepted', receipt: { eventId: event.eventId,
          payloadSha256: createHash('sha256').update(body).digest('hex') } } })
        return
      }
      if (req.url === '/api/me/stamina' || req.url === '/api/me/subscriptions' || req.url?.startsWith('/api/marketplace')) {
        respond(200, { data: [] }); return
      }
      if (req.url === '/api/me/trial-status') {
        respond(200, { data: { asOf: new Date().toISOString(), paidGroupIds: [], trials: [] } }); return
      }
      if (req.url === '/api/me/connections?catalog=all') {
        respond(200, { data: { available: false, toolkits: [], accounts: [] } }); return
      }
      respond(404, { error: 'not_found' })
    })().catch((error: unknown) => { fixtureErrors.push(error); res.destroy() })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  let directory: string | undefined
  let browser: Browser | undefined
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  const failures: unknown[] = []
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture listener')
    const origin = `http://127.0.0.1:${address.port}`
    directory = await mkdtemp(join(tmpdir(), 'verboo-product-clicks-'))
    browser = await chromium.launch()
    const overlay = join(directory, 'analytics.patch.yml')
    const readyFile = join(directory, 'first-turn-ready')
    const secondReadyFile = join(directory, 'second-turn-ready')
    const replayOverride = join(directory, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify([{ kind: 'hang', readyFile }, { kind: 'hang', readyFile: secondReadyFile }]))
    await writeFile(overlay, `- id: verboo-account
  disabled: true
- id: verboo-product
  config:
    apiOrigin: ${JSON.stringify(origin)}
    routerBaseURL: ${JSON.stringify(origin + '/router/v1')}
    allowLoopbackHttp: true
- id: verboo-product-analytics
  config:
    apiOrigin: ${JSON.stringify(origin)}
    routerBaseURL: ${JSON.stringify(origin + '/router/v1')}
    allowLoopbackHttp: true
    surface: desktop
    appVersion: e2e-fixture
    retryIntervalMs: 1000
- id: agent-default-model
  config:
    provider: deepseek-account
    model: unlimited/deepseek-v4-flash
- insert:
    - id: analytics-fixture-account
      name: ${JSON.stringify(join(ROOT, 'apps/web/tests/fixtures/verboo-stamina/account.mjs'))}
      config:
        accountId: ${ACCOUNT}
        apiOrigin: ${JSON.stringify(origin)}
`)
    scaffold = await launchWebScaffold({
      profile: { hmr: false, packages: [{ dir: join(ROOT, 'packages/bundle/verboo-app'), enabled: true }] },
      welcomeNoticePending: true,
      replayFixture: join(ROOT, 'snapshots/web/live-interactions/session.v3.jsonl'),
      replayOverride,
      compareReplaySession: false,
      replayProviders: [{ id: 'deepseek-account', name: 'Fixture', models: [
        { id: 'unlimited/deepseek-v4-flash', name: 'Fixture model', contextWindow: 128000,
          reasoningEfforts: ['low', 'high'] },
      ] }],
      extraOverlayPath: overlay,
    })
    const session = await selectedSessionFixture(join(ROOT, 'snapshots/web/turn-tail-actions/session.v4.jsonl'))
    await seedSession(scaffold, await readFile(session, 'utf8'), 'analytics-history')
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, locale: 'en-US', reducedMotion: 'reduce' })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => { pageErrors.push(error.message) })
    await page.addInitScript(() => { Object.assign(window, { __DSH_DIRECTORY_PICKER__: { pick: async () => null } }) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-verboo-onboarding]').waitFor({ state: 'hidden' })
    await expect.poll(async () => (await scaffold!.ctx.verbooAnalytics.status()).consent?.decision, { timeout: 10000 }).toBe('granted')
    const remoteStatus = await scaffold.hostFetch('/api/verbooAnalytics/status', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'verbooAnalytics/status', payload: { args: {} } }),
    })
    expect(await remoteStatus.json()).toMatchObject({ result: { ok: true, value: { consent: {
      decision: 'granted', referenceProof: expect.stringMatching(/^v1\./) as unknown,
    } } } })
    try {
      await expect.poll(() => events.some(event => String(event.feature).startsWith('preference_')), { timeout: 20000 }).toBe(true)
    } catch (error) {
      throw new Error(`No preference event; requests: ${requests.join(', ')}; errors: ${pageErrors.join(', ')}; page: ${(await page.locator('body').innerText()).slice(0, 700)}`, { cause: error })
    }
    const defaults = ['preference_busy_queue', 'preference_minimalist_off', 'preference_coding_tools_on',
      'preference_theme_system', 'preference_language_en']
    await expect.poll(() => defaults.filter(feature => events.some(event => event.feature === feature)).length,
      { timeout: 10000 }).toBe(defaults.length)
    await page.getByRole('button', { name: /^(Workspace|Área de trabalho)$/ }).first().click()
    await page.getByRole('button', { name: /^(Add project|Adicionar projeto)$/ }).click()
    await expect.poll(() => events.some(event => event.feature === 'project_add' && event.outcome === 'cancelled'), { timeout: 10000 }).toBe(true)
    await expect.poll(() => events.some(event => event.feature === 'project_add' && event.outcome === 'started'), { timeout: 10000 }).toBe(true)
    await page.locator('[data-verboo-session="analytics-history"]').getByRole('button').first().click()
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Fixture model', exact: true }).click()
    await expect.poll(() => events.some(event => event.feature === 'model_choice'), { timeout: 10000 }).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({ feature: 'model_choice', modelProvider: 'verboo',
      modelName: 'unlimited/deepseek-v4-flash', modelEffort: 'default' }))
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Effort/ }).click()
    const effort = page.getByRole('slider', { name: 'Reasoning level' })
    const effortBounds = await effort.boundingBox()
    if (effortBounds === null) throw new Error('Reasoning level slider is not visible')
    await effort.click({ position: { x: effortBounds.width - 2, y: effortBounds.height / 2 } })
    await expect.poll(() => effort.getAttribute('aria-valuetext')).toBe('High')
    await expect.poll(() => events.some(event => event.feature === 'model_choice' && event.modelEffort === 'high'), { timeout: 10000 }).toBe(true)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const editor = page.locator('[data-composer-input]').first()
    await editor.fill('Fixture message by button')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => existsSync(readyFile), { timeout: 15000 }).toBe(true)
    await expect.poll(() => events.some(event => event.feature === 'message_button'), { timeout: 10000 }).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({ feature: 'message_button', modelProvider: 'verboo',
      modelName: 'unlimited/deepseek-v4-flash', modelEffort: 'high' }))
    await editor.fill('Fixture queued by Enter')
    await editor.press('Enter')
    await expect.poll(() => events.some(event => event.feature === 'message_queue_enter'), { timeout: 10000 }).toBe(true)
    await editor.fill('Fixture queued by button')
    await page.getByRole('button', { name: 'Queue message', exact: true }).click()
    await expect.poll(() => events.some(event => event.feature === 'message_queue_button'), { timeout: 10000 }).toBe(true)
    await page.getByRole('button', { name: '2 queued messages', exact: true }).click()
    await page.getByRole('button', { name: 'Steer queued message', exact: true }).first().click()
    await expect.poll(() => events.some(event => event.feature === 'queue_steer_button'), { timeout: 10000 }).toBe(true)
    await editor.fill('Fixture immediate by keyboard')
    await editor.press('Control+Enter')
    await expect.poll(() => events.some(event => event.feature === 'message_steer_enter'), { timeout: 10000 }).toBe(true)
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await expect.poll(() => events.some(event => event.feature === 'stop_button'), { timeout: 10000 }).toBe(true)
    await expect.poll(() => page.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 15000 }).toBe(0)
    await editor.fill('Fixture message by Enter')
    await editor.press('Enter')
    await expect.poll(() => existsSync(secondReadyFile), { timeout: 15000 }).toBe(true)
    await expect.poll(() => events.some(event => event.feature === 'message_enter'), { timeout: 10000 }).toBe(true)
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 15000 }).toBe(0)
    await page.getByRole('button', { name: 'Split to the right' }).first().click()
    await expect.poll(() => events.some(event => event.feature === 'pane_split_right'), { timeout: 10000 }).toBe(true)
    await page.getByRole('button', { name: 'Split below' }).last().click()
    await expect.poll(() => events.some(event => event.feature === 'pane_split_down'), { timeout: 10000 }).toBe(true)
    expect(events.filter(event => event.feature === 'project_add' && event.outcome === 'started')).toHaveLength(1)
    expect(events.filter(event => event.feature === 'project_add' && event.outcome === 'cancelled')).toHaveLength(1)
    expect([...installationHeaders]).toHaveLength(1)
    expect([...installationHeaders][0]).toMatch(/^[a-f0-9]{64}$/)
    expect(events.filter(event => event.name === 'product_feature_used').every(event => event.surface === 'desktop' && event.appVersion === 'e2e-fixture')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(ACCOUNT)
    expect(JSON.stringify(events)).not.toContain('Fixture message')
    expect(JSON.stringify(events)).not.toContain('Fixture queued')
    expect(JSON.stringify(events)).not.toContain('Fixture immediate')
    expect(fixtureErrors).toEqual([])
    expect(pageErrors).toEqual([])
  } catch (error) {
    failures.push(error)
  } finally {
    try { await browser?.close() } catch (error) { failures.push(error) }
    try { await scaffold?.close() } catch (error) { failures.push(error) }
    try {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
    } catch (error) { failures.push(error) }
    try { if (directory !== undefined) await rm(directory, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Product analytics E2E failed')
})
