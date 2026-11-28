/** Exercise the desktop tour in the assembled Verboo profile and compare its accessible UI. */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ACCOUNT = '00000000-0000-4000-8000-000000000002'
const MODE = webSnapshotMode()

it.skipIf(MODE === 'record')('introduces the desktop tools and points to the Connections navigation', async () => {
  const cleanup: Array<() => Promise<unknown>> = []
  const failures: unknown[] = []
  const server = createServer((req, res) => {
    if (req.url === '/api/me/trial-status') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { asOf: new Date().toISOString(), paidGroupIds: [], trials: [] } }))
    } else if (req.url === '/api/me/stamina' || req.url === '/api/me/subscriptions' || req.url?.startsWith('/api/marketplace')) {
      res.setHeader('content-type', 'application/json')
      res.end('{"data":[]}')
    } else {
      res.writeHead(404).end()
    }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    cleanup.push(() => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Tour fixture listener did not start')
    const origin = 'http://127.0.0.1:' + address.port
    const directory = await mkdtemp(join(tmpdir(), 'verboo-tour-browser-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const overlay = join(directory, 'tour.patch.yml')
    await writeFile(overlay, `- id: verboo-account
  disabled: true
- id: verboo-product
  config:
    apiOrigin: ${origin}
    routerBaseURL: ${origin}/router/v1
    allowLoopbackHttp: true
- id: verboo-product-analytics
  disabled: true
- id: agent-default-model
  config:
    provider: deepseek-account
    model: pro/deepseek-v4-flash
- insert:
    - id: tour-fixture-account
      name: ${JSON.stringify(join(ROOT, 'apps/web/tests/fixtures/verboo-stamina/account.mjs'))}
      config:
        accountId: ${ACCOUNT}
        apiOrigin: ${origin}
`)
    const scaffold = await launchWebScaffold({
      profile: { hmr: false, packages: [{ dir: join(ROOT, 'packages/bundle/verboo-app'), enabled: true }] },
      welcomeNoticePending: true,
      replayFixture: join(ROOT, 'apps/web/tests/fixtures/model-badge/session.v4.jsonl'),
      replayProvidersOnly: true,
      replayProviders: [
        { id: 'deepseek-account', name: 'Verboo Code fixture',
          models: [{ id: 'pro/deepseek-v4-flash', name: 'Fixture model', contextWindow: 128_000 }] },
        { id: 'deepseek-official', name: 'Recorded fixture',
          models: [{ id: 'deepseek-v4-flash', name: 'Recorded fixture model', contextWindow: 128_000 }] },
      ],
      extraOverlayPath: overlay,
    })
    cleanup.push(() => scaffold.close())
    const browser = await chromium.launch()
    cleanup.push(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, locale: 'pt-BR', reducedMotion: 'reduce' })
    await page.addInitScript(() => {
      Object.defineProperty(window, '__VERBOO_DESKTOP__', {
        value: { framework: 'tauri', protocolVersion: 1, openExternal: async () => {} },
      })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-verboo-onboarding]').waitFor({ state: 'hidden' })
    const welcome = page.getByRole('dialog', { name: 'Boas-vindas ao Verboo Code!' })
    await welcome.waitFor()
    const expected = join(ROOT, 'apps/web/tests/expected/verboo-first-use-tour')
    if (MODE === 'refresh') await mkdir(expected, { recursive: true })
    const selector = '[role="dialog"][aria-modal="true"]'
    await compareOrRefreshGolden(join(expected, 'welcome.expected.md'), await captureStableAria(page, selector, scaffold.workspaceCwd), MODE)
    await welcome.getByRole('button', { name: 'Começar tour' }).click()
    const next = () => page.getByRole('button', { name: 'Próximo', exact: true }).click()
    for (const name of ['Adicione um projeto', 'Escolha um modelo', 'Envie sua primeira mensagem', 'Divida a tela', 'Arquivos e terminal']) {
      await page.getByRole('dialog', { name, exact: true }).waitFor()
      await next()
    }
    const connections = page.getByRole('dialog', { name: 'Conexões', exact: true })
    await connections.waitFor()
    await connections.locator(':scope[data-point]').waitFor()
    const anchor = await page.locator('[data-verboo-tour-connections]').boundingBox()
    if (anchor === null) throw new Error('Connections navigation is missing')
    const highlight = await page.locator('[data-verboo-first-use-tour] > [aria-hidden="true"]').boundingBox()
    if (highlight === null) throw new Error('Connections highlight is missing')
    expect(highlight.x).toBeCloseTo(anchor.x - 5, 0)
    expect(highlight.y).toBeCloseTo(anchor.y - 5, 0)
    await compareOrRefreshGolden(join(expected, 'connections.expected.md'), await captureStableAria(page, selector, scaffold.workspaceCwd), MODE)
    await connections.getByRole('button', { name: 'Concluir' }).click()
    await connections.waitFor({ state: 'detached' })
    await expect.poll(() => scaffold.ctx.settings.describe().find(row => row.ns === 'ui-verboo')?.value)
      .toMatchObject({ firstUseTourSeen: true })
  } catch (error) {
    failures.push(error)
  } finally {
    for (const close of cleanup.reverse()) {
      try { await close() } catch (error) { failures.push(error) }
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Desktop tour browser test failed')
})
