/** Built app trial attention, explicit Pix authorization and restart recovery against a loopback fixture. */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  selectedSessionFixture, webSnapshotMode,
} from './scaffold.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PLAN = '00000000-0000-4000-8000-000000000001'
const MAX = '00000000-0000-4000-8000-000000000004'
const ACCOUNT = '00000000-0000-4000-8000-000000000002'
const ATTEMPT = '00000000-0000-4000-8000-000000000005'

it('shows trial attention and an explicit quote, then resumes only the original Pix purchase after restart', async () => {
  const cleanup: Array<() => Promise<unknown>> = []
  const artifacts = await mkdtemp(join(tmpdir(), 'verboo-trial-ui-qa-'))
  let page: Page | undefined
  let failure: unknown
  let ended = false
  let writes = 0
  let completed = false
  let finalAttemptObserved = false
  const server = createServer((req, res) => {
    void (async () => {
      expect(req.headers.authorization).toBe(`Bearer stamina-fixture:${ACCOUNT}`)
      let data: unknown
      if (req.url === '/api/me/subscriptions') data = [{ id: PLAN, groupId: PLAN, group: { name: 'Pro', slug: 'pro' }, status: completed ? 'active' : 'trialing', cancelAtPeriodEnd: false, management: { changePlan: false }, billing: null }]
      else if (req.url?.startsWith('/api/marketplace')) data = [
        { id: PLAN, slug: 'pro', name: 'Pro', description: 'Daily coding projects', currency: 'usd', priceCents: 6900, billingInterval: 'month' },
        { id: MAX, slug: 'max', name: 'Max', description: 'More parallel projects', currency: 'usd', priceCents: 12900, billingInterval: 'month' },
      ]
      else if (req.url === '/api/me/stamina') data = []
      else if (req.url === '/api/me/trial-status') data = { asOf: new Date().toISOString(), paidGroupIds: completed ? [PLAN] : [], trials: completed ? [] : [{ id: 'tokens:' + PLAN, groupId: PLAN, source: 'free_tokens', state: ended ? 'ended' : 'ending', hasSavedCard: true, tokensRemaining: ended ? 0 : 200, tokenLimit: 1000 }] }
      else if (req.url === '/api/me/free-tokens/activation') data = { token: 'host-only-activation', attemptId: ATTEMPT, groupId: PLAN, amountCents: 6900, renewalAmountCents: 6900, currency: 'usd', billingInterval: 'month', expiresAt: new Date(Date.now() + 300000).toISOString(), card: { brand: 'visa', last4: '4242' } }
      else if (req.url === '/api/me/checkout/quotes') {
        let raw = ''; for await (const chunk of req) raw += String(chunk)
        const pix = (JSON.parse(raw) as { paymentMethod?: string }).paymentMethod === 'pix'
        data = { available: true, quoteId: pix ? 'host-only-pix' : 'host-only-card', expiresAt: new Date(Date.now() + 300000).toISOString(), initialAmountMinor: pix ? 36118 : 6900, renewalAmountMinor: pix ? 36118 : 6900, currency: pix ? 'brl' : 'usd', paymentMethods: [pix ? 'pix' : 'card'], pixAvailable: true, ...(pix ? { pixMandateAmountMinor: 37383 } : {}), billingInterval: 'month' }
      } else if (req.url === `/api/me/groups/${PLAN}/checkout`) {
        let raw = ''; for await (const chunk of req) raw += String(chunk)
        expect(JSON.parse(raw)).toMatchObject({ checkoutQuoteId: 'host-only-pix', subscribeNow: true, quotedPaymentMethod: 'pix' })
        writes++
        data = { mode: 'stripe', attemptId: ATTEMPT, url: 'https://checkout.stripe.com/original-fixture' }
      } else if (req.url === `/api/me/purchase-attempts/${ATTEMPT}`) {
        finalAttemptObserved ||= completed
        data = { status: completed ? 'succeeded' : 'pending' }
      }
      else if (req.url === `/api/me/purchase-attempts/${ATTEMPT}/resume`) data = { mode: 'stripe', attemptId: ATTEMPT, url: 'https://checkout.stripe.com/original-fixture' }
      else { res.writeHead(404).end('{}'); return }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
    })().catch((error: unknown) => { res.destroy(error instanceof Error ? error : new Error('Fixture failed')) })
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture listener missing')
    const origin = `http://127.0.0.1:${address.port}`
    const home = await mkdtemp(join(tmpdir(), 'verboo-trial-browser-'))
    cleanup.push(() => rm(home, { recursive: true, force: true }))
    const overlay = join(home, 'trial.patch.yml')
    await writeFile(overlay, `- id: verboo-account\n  disabled: true\n- id: verboo-product\n  config:\n    apiOrigin: ${origin}\n    routerBaseURL: ${origin}/router/v1\n    allowLoopbackHttp: true\n- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: pro/deepseek-v4-flash\n- insert:\n    - id: trial-fixture-account\n      name: ${JSON.stringify(fileURLToPath(new URL('./fixtures/verboo-stamina/account.mjs', import.meta.url)))}\n      config:\n        accountId: ${ACCOUNT}\n        apiOrigin: ${origin}\n`)
    const scaffold = await launchWebScaffold({
      profile: { hmr: false, packages: [{ dir: join(ROOT, 'packages/bundle/verboo-app'), enabled: true }] },
      welcomeNoticePending: true,
      replayFixture: join(ROOT, 'apps/web/tests/fixtures/model-badge/session.v4.jsonl'),
      replayProvidersOnly: true,
      replayProviders: [{ id: 'deepseek-account', name: 'Verboo Code fixture', models: [{ id: 'pro/deepseek-v4-flash', name: 'Fixture model', contextWindow: 128000 }] }, { id: 'deepseek-official', name: 'Recorded fixture provider', models: [{ id: 'deepseek-v4-flash', name: 'Recorded fixture model', contextWindow: 128000 }] }],
      extraOverlayPath: [join(ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml'), overlay],
    })
    cleanup.push(() => scaffold.close())
    await seedSession(scaffold, await readFile(await selectedSessionFixture(join(ROOT, 'snapshots/web/turn-tail-actions/session.v4.jsonl')), 'utf8'), 'trial-history')
    const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {})
    cleanup.push(() => browser.close())
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'pt-BR' })
    page = await context.newPage()
    page.setDefaultTimeout(15000)
    // Loading all built bundles is startup work, bounded separately from interaction assertions.
    page.setDefaultNavigationTimeout(60000)
    // No fixture ever navigates to a payment provider or sends a real payment.
    await context.route('https://checkout.stripe.com/**', route => route.fulfill({ status: 200, body: 'Fixture payment destination' }))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-verboo-onboarding]').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: /^(Workspace|Área de trabalho)$/ }).first().click()
    await page.locator('[data-verboo-session="trial-history"]').getByRole('button').first().click()
    await page.locator('[data-verboo-trial-notice]').waitFor()
    expect(await page.locator('[data-verboo-trial-notice]').textContent()).toContain('200')
    expect(await page.getByRole('dialog').count()).toBe(0)
    await page.screenshot({ path: join(artifacts, 'composer-notice.png'), animations: 'disabled' })
    ended = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await dialog.getByText(/4242/).waitFor()
    expect(await dialog.textContent()).toContain('USD')
    expect(await dialog.textContent()).toContain('Daily coding projects')
    expect(await dialog.textContent()).toContain('More parallel projects')
    expect(writes).toBe(0)
    const mode = webSnapshotMode()
    const expected = join(ROOT, 'apps/web/tests/expected/verboo-trial')
    if (mode === 'refresh') await mkdir(expected, { recursive: true })
    await compareOrRefreshGolden(join(expected, 'offer.expected.md'), await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), mode)
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 960 })
        const box = await dialog.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: join(artifacts, `offer-${theme}-${width}.png`), animations: 'disabled' })
      }
    }
    await dialog.getByRole('button', { name: /^(Pay with Pix|Pagar com Pix)$/ }).click()
    await dialog.getByText(/BRL/).first().waitFor()
    expect(writes).toBe(0)
    await dialog.getByRole('button', { name: /^(Confirm and pay|Confirmar e pagar)/ }).click()
    await expect.poll(() => writes).toBe(1)
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('dialog').waitFor()
    await page.getByRole('button', { name: /^(Reopen payment|Retomar pagamento)$/ }).waitFor()
    expect(writes).toBe(1)
    completed = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    expect(writes).toBe(1)
    await expect.poll(() => finalAttemptObserved).toBe(true)
    await writeFile(join(artifacts, 'sanitized-attempt.json'), JSON.stringify({
      fixture: true, realPayment: false, attemptId: ATTEMPT, finalAttemptStatus: 'succeeded', checkoutWrites: writes,
    }, null, 2) + '\n')
    console.info('Trial QA artifacts:', artifacts)
  } catch (error) {
    failure = error
    if (page && !page.isClosed()) await Promise.allSettled([
      page.screenshot({ path: join(artifacts, 'failure.png'), animations: 'disabled' }),
      page.locator('body').ariaSnapshot().then(aria => writeFile(join(artifacts, 'failure.aria.txt'), aria)),
    ])
    console.info('Trial QA failure artifacts:', artifacts)
    throw error
  } finally {
    const failures: unknown[] = []
    for (const close of cleanup.reverse()) { try { await close() } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failure === undefined ? failures : [failure, ...failures], 'Trial fixture cleanup failed')
  }
})
