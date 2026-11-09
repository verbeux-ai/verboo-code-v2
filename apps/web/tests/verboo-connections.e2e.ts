/**
 * Browser coverage for the redesigned Connections page: the three sections,
 * catalog grouping and filtering, the MCP editor with its saved keys, the
 * connection test, and no horizontal overflow at a narrow width.
 */
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const ACCOUNT_A = '00000000-0000-4000-8000-000000000002'
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MODE = webSnapshotMode()
const ARTIFACTS = process.env.CONNECTIONS_QA_DIR ?? join(tmpdir(), 'verboo-connections-qa')

const TOOLKITS: ReadonlyArray<readonly [string, string]> = [
  ['github', 'GitHub'], ['gitlab', 'GitLab'], ['linear', 'Linear'], ['jira', 'Jira'],
  ['slack', 'Slack'], ['gmail', 'Gmail'], ['notion', 'Notion'], ['asana', 'Asana'],
  ['googledrive', 'Google Drive'], ['figma', 'Figma'], ['airtable', 'Airtable'],
  ['postgres', 'PostgreSQL'], ['hubspot', 'HubSpot'], ['stripe', 'Stripe'],
  ['intercom', 'Intercom'], ['zendesk', 'Zendesk'],
]

/** The one-pixel PNG this fixture serves as the catalog mark. */
const MARK_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Loopback product API: one connected account, one expired one, and a catalog across categories. */
async function platformFixture() {
  const state = { connectionsDown: false, origin: '' }
  const respond = (res: ServerResponse, status: number, body: unknown) => {
    if (res.destroyed) return
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }
  const server = createServer((req, res) => {
    // The brand mark is a public asset the browser loads without the Host
    // credential, so it answers before the authenticated API routes.
    if (req.url === '/catalog-mark.png') {
      if (res.destroyed) return
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(MARK_BYTES)
      return
    }
    if (req.headers.authorization?.startsWith('Bearer stamina-fixture:') !== true) {
      respond(res, 401, { error: 'unauthorized' })
      return
    }
    if (req.url?.startsWith('/api/me/connections?catalog=all')) {
      if (state.connectionsDown) { respond(res, 503, { error: 'unavailable' }); return }
      respond(res, 200, {
        data: {
          available: true,
          toolkits: [
            // The catalog marks one service so the page can show it beside the name.
            ...TOOLKITS.map(([slug, name]) => ({
              slug, name, available: true, authType: 'oauth',
              ...(slug === 'googledrive' ? { logo: `${state.origin}/catalog-mark.png` } : {}),
            })),
            { slug: 'searxng', name: 'SearXNG', available: true, authType: 'none' },
          ],
          accounts: [
            { id: 'connection-github', toolkit: 'github', label: 'Work', status: 'connected' },
            { id: 'connection-linear', toolkit: 'linear', label: 'Personal', status: 'expired' },
          ],
        },
      })
      return
    }
    if (req.url === '/api/me/stamina') { respond(res, 200, { data: [] }); return }
    if (req.url === '/api/me/subscriptions') { respond(res, 200, { data: [] }); return }
    if (req.url?.startsWith('/api/marketplace')) { respond(res, 200, { data: [] }); return }
    respond(res, 404, { error: 'not_found' })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('loopback API did not start')
  state.origin = `http://127.0.0.1:${address.port}`
  return {
    state,
    origin: state.origin,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeAllConnections()
    }),
  }
}

describe.skipIf(MODE === 'record')('Verboo Connections page in the built application', () => {
  let platform: Awaited<ReturnType<typeof platformFixture>>
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let directory: string

  const pageRegion = () => page.locator('[data-verboo-page="connections"]')
  const mcpSection = () => pageRegion().locator('section').filter({ hasText: 'Servidores MCP' }).first()
  const catalogSection = () => pageRegion().locator('section').filter({ hasText: 'Serviços disponíveis' }).first()

  /** Call one Host Remote method the way the page does. */
  async function call(method: string, args: unknown): Promise<void> {
    const origin = new URL(page.url()).origin
    await page.evaluate(async ({ origin, method, args }) => {
      await fetch(`${origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'spec', method, payload: { args } }),
      })
    }, { origin, method, args })
  }

  beforeAll(async () => {
    platform = await platformFixture()
    directory = await mkdtemp(join(tmpdir(), 'verboo-connections-browser-'))
    await mkdir(ARTIFACTS, { recursive: true })
    const overlay = join(directory, 'connections.patch.yml')
    await writeFile(overlay, `- id: verboo-account
  disabled: true
- id: verboo-product
  config:
    apiOrigin: ${JSON.stringify(platform.origin)}
    routerBaseURL: ${JSON.stringify(platform.origin + '/router/v1')}
    allowLoopbackHttp: true
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
- insert:
    - id: connections-fixture-account
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
      replayProviders: [{ id: 'deepseek-official', name: 'Verboo Code fixture', models: [{ id: 'deepseek-v4-flash', name: 'Fixture model', contextWindow: 128000 }] }],
      extraOverlayPath: [
        join(ROOT, 'packages/bundle/verboo-app/cordis.patch.yml'),
        join(ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml'),
        overlay,
      ],
      extraInstallAnchors: [join(ROOT, 'packages/bundle/verboo-app/package.json')],
    })
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {})
    page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'pt-BR' })
    page.setDefaultTimeout(15000)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-verboo-onboarding]').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: /Conexões/ }).first().click()
    await pageRegion().waitFor()
    await writeFile(join(ARTIFACTS, 'connections.aria.txt'), await pageRegion().ariaSnapshot())
  }, 180000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await platform?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('separates owned accounts, an empty MCP section and a grouped catalog', async () => {
    const accounts = pageRegion().locator('section').filter({ hasText: 'Contas conectadas' }).first()
    await expect.poll(() => accounts.getByText('Work').count()).toBeGreaterThan(0)
    expect(await accounts.getByText('Personal').count()).toBeGreaterThan(0)
    // An unavailable provider read is still a distinct, actionable state.
    expect(await mcpSection().getByText(/Nenhum servidor MCP/).count()).toBe(1)
    const categories = pageRegion().getByRole('group', { name: 'Filtrar por categoria' })
    expect(await categories.getByRole('button').count()).toBeGreaterThan(5)
    // Nothing is listed until a category is chosen.
    expect(await catalogSection().getByText('Escolha uma categoria para ver os serviços.').count()).toBe(1)
    expect(await catalogSection().getByRole('heading', { name: 'GitHub' }).count()).toBe(0)
    await page.screenshot({ path: join(ARTIFACTS, 'connections-overview.png'), animations: 'disabled' })
  })

  it('reveals one category at a time and searches across all of them', async () => {
    await pageRegion().getByRole('group', { name: 'Filtrar por categoria' })
      .getByRole('button', { name: /Desenvolvimento/ }).click()
    await expect.poll(() => catalogSection().getByRole('heading', { name: 'GitHub' }).count()).toBe(1)
    expect(await catalogSection().getByRole('heading', { name: 'Stripe' }).count()).toBe(0)
    await page.screenshot({ path: join(ARTIFACTS, 'connections-category.png'), animations: 'disabled' })

    // The category list returns on demand, revealing nothing again.
    await pageRegion().getByRole('button', { name: /Todas as categorias/ }).click()
    await expect.poll(() => catalogSection().getByRole('heading', { name: 'GitHub' }).count()).toBe(0)

    await pageRegion().getByRole('group', { name: 'Filtrar por categoria' })
      .getByRole('button', { name: /Finanças/ }).click()
    await expect.poll(() => catalogSection().getByRole('heading', { name: 'Stripe' }).count()).toBe(1)

    // A search looks across every category without picking one.
    await pageRegion().getByRole('button', { name: /Todas as categorias/ }).click()
    await pageRegion().getByLabel('Buscar um serviço').fill('git')
    await expect.poll(() => catalogSection().getByRole('heading', { name: 'GitHub' }).count()).toBe(1)
    expect(await catalogSection().getByRole('heading', { name: 'Stripe' }).count()).toBe(0)
    await pageRegion().getByLabel('Buscar um serviço').fill('')
    await expect.poll(() => catalogSection().getByRole('heading', { name: 'GitHub' }).count()).toBe(0)
  })

  it('shows the catalog brand mark beside the service and on its account', async () => {
    await pageRegion().getByRole('group', { name: 'Filtrar por categoria' })
      .getByRole('button', { name: /Produtividade/ }).click()
    await pageRegion().getByLabel('Buscar um serviço').fill('drive')
    const card = catalogSection().locator('article').filter({ hasText: 'Google Drive' }).first()
    await expect.poll(() => card.count()).toBe(1)
    // The mark the catalog carried is loaded, not merely referenced.
    const mark = card.locator('img')
    expect(await mark.count()).toBe(1)
    expect(await mark.getAttribute('src')).toContain('/catalog-mark.png')
    await expect.poll(() => mark.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
    // The adjacent name labels it, so the mark stays out of the accessibility tree.
    expect(await mark.getAttribute('alt')).toBe('')
    expect(await mark.getAttribute('aria-hidden')).toBe('true')
  })

  it('creates a server, then edits it with its key shown and its value blank', async () => {
    await pageRegion().getByRole('button', { name: /Adicionar servidor MCP/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await expect.poll(() => dialog.getByRole('button', { name: 'Salvar' }).isDisabled()).toBe(true)
    await dialog.getByLabel('Nome do servidor').fill('docs')
    await dialog.getByLabel('URL do endpoint').fill('https://mcp.example.com/mcp')
    await dialog.getByRole('textbox', { name: 'Cabeçalho', exact: true }).fill('Authorization')
    await dialog.getByRole('textbox', { name: 'Valor', exact: true }).fill('top-secret')
    await expect.poll(() => dialog.getByRole('button', { name: 'Salvar' }).isEnabled()).toBe(true)
    await dialog.getByRole('button', { name: 'Salvar' }).click()
    await expect.poll(() => mcpSection().getByText('docs').count()).toBeGreaterThan(0)

    // The secret never comes back: the edit form shows the key only.
    const card = mcpSection().locator('article').filter({ hasText: 'docs' }).first()
    await card.getByRole('button', { name: 'Editar' }).click()
    await expect.poll(() => dialog.getByRole('textbox', { name: 'Cabeçalho', exact: true }).count()).toBe(1)
    expect(await dialog.getByRole('textbox', { name: 'Cabeçalho', exact: true }).inputValue()).toBe('Authorization')
    expect(await dialog.locator('input[type="password"]').count()).toBeGreaterThan(0)
    expect(await dialog.locator('input[value="top-secret"]').count()).toBe(0)
    await page.screenshot({ path: join(ARTIFACTS, 'connections-editor.png'), animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Cancelar' }).click()
  })

  it('tests a saved server and reports the failing stage', async () => {
    const card = mcpSection().locator('article').filter({ hasText: 'docs' }).first()
    await card.getByRole('button', { name: 'Testar' }).click()
    await expect.poll(async () => (await card.textContent()) ?? '', { timeout: 30000 })
      .toMatch(/Não foi possível conectar|Conectou, mas/)
  })

  it('toggles and removes a server with confirmation', async () => {
    await call('verbooMcp/save', {
      input: {
        name: 'toggle-demo', transport: 'streamable-http', url: 'https://mcp.example.com/toggle',
        headers: {}, command: '', args: [], env: {}, enabled: false,
      },
    })
    await pageRegion().getByRole('button', { name: 'Atualizar' }).first().click()
    await expect.poll(() => mcpSection().getByText('toggle-demo').count()).toBeGreaterThan(0)
    const card = mcpSection().locator('article').filter({ hasText: 'toggle-demo' }).first()
    const pill = card.locator('span[data-tone]').first()
    const toggle = card.getByRole('button', { name: /^(Ativar|Desativar) toggle-demo$/ })
    await toggle.click()
    await page.waitForTimeout(2500)
    await expect.poll(async () => (await toggle.textContent()) ?? '').toBe('Desativar')
    await toggle.click()
    await expect.poll(async () => (await toggle.textContent()) ?? '').toBe('Ativar')
    await expect.poll(async () => (await pill.textContent()) ?? '').toBe('Desativado')

    await card.getByRole('button', { name: 'Remover' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'Cancelar' }).click()
    await expect.poll(() => mcpSection().getByText('toggle-demo').count()).toBeGreaterThan(0)
    await card.getByRole('button', { name: 'Remover' }).click()
    await dialog.getByRole('button', { name: 'Remover servidor' }).click()
    await expect.poll(() => mcpSection().getByText('toggle-demo').count()).toBe(0)
  })

  it('keeps a failed catalog read actionable and stays within a narrow viewport', async () => {
    const unavailable = /indisponíveis/i
    platform.state.connectionsDown = true
    await pageRegion().getByRole('button', { name: 'Atualizar' }).first().click()
    await expect.poll(() => pageRegion().getByRole('alert').filter({ hasText: unavailable }).count()).toBeGreaterThan(0)
    platform.state.connectionsDown = false
    await pageRegion().getByRole('button', { name: 'Atualizar' }).first().click()
    await expect.poll(() => pageRegion().getByRole('alert').filter({ hasText: unavailable }).count()).toBe(0)

    await pageRegion().getByRole('button', { name: 'Atualizar' }).first().click()
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
        await page.screenshot({ path: join(ARTIFACTS, `connections-${theme}-${width}.png`), animations: 'disabled' })
        await catalogSection().scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(ARTIFACTS, `catalog-${theme}-${width}.png`), animations: 'disabled' })
      }
    }
  })

  it('drives the same state through the Host Remote surface the tools use', async () => {
    await call('verbooMcp/save', {
      input: {
        name: 'remote', transport: 'streamable-http', url: 'https://mcp.example.com/remote',
        headers: {}, command: '', args: [], env: {}, enabled: false,
      },
    })
    await pageRegion().getByRole('button', { name: 'Atualizar' }).first().click()
    await expect.poll(() => mcpSection().getByText('remote').count()).toBeGreaterThan(0)
    await call('verbooMcp/removeServer', { name: 'remote' })
    await pageRegion().getByRole('button', { name: 'Atualizar' }).first().click()
    await expect.poll(() => mcpSection().getByText('remote').count()).toBe(0)
  })
})
