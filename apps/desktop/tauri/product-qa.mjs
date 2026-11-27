/** Exercise the shipped Verboo profile with external HTTP fixtures and a temporary OS credential. Run from the repository root after build:artifacts. */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyPanes, verifySendLifecycle, verifyHeaderHover, verifyComposerActivation } from './panes-qa.mjs'
const root = process.cwd(),
  require = createRequire(join(root, 'apps/web/package.json'))
const { chromium, webkit } = require('playwright')
const { WebSocketServer } = require('ws')
const home = await mkdtemp(join(tmpdir(), 'verboo-redesign-qa-'))
const dir =
  process.env.VERBOO_QA_OUTPUT ??
  join(root, 'apps/desktop/.desktop-build/tauri/product-qa')
await mkdir(dir, { recursive: true })
await rm(join(dir, 'failure.png'), { force: true })
const id = '00000000-0000-4000-8000-000000000001',
  other = '00000000-0000-4000-8000-000000000002'
const toolkitNames = {
  github: 'GitHub',
  googledrive: 'Google Drive',
  notion: 'Notion',
  slack: 'Slack',
  gmail: 'Gmail',
  googlecalendar: 'Google Calendar',
  linear: 'Linear',
  figma: 'Figma',
  hackernews: 'Hacker News',
  ...Object.fromEntries(Array.from({ length: 1709 }, (_, index) => [`service_${String(index).padStart(4, '0')}`, `Service ${String(index).padStart(4, '0')}`])),
}
const plan = (id, name, priceCents) => ({
  id,
  name,
  description:
    'Para transformar ideias em projetos, com modelos de código e ferramentas conectadas.',
  priceCents,
  currency: 'BRL',
  billingInterval: 'month',
  billingMode: 'subscription',
  newAcquisitionEnabled: true,
  apiOnly: false,
})
const plans = [
  plan(other, 'Verboo Max', 29900),
  plan(id, 'Verboo Pro', 14900),
  { ...plan('00000000-0000-4000-8000-000000000004', 'Lite', 9900), description: 'Uso limitado com franquia semanal, renovada a cada 7 dias a partir do primeiro uso. Após esgotar a franquia, novas requisições aguardam a renovação. Inclui todos os modelos disponíveis e até 8 requisições simultâneas.' },
  { ...plan('00000000-0000-4000-8000-000000000005', 'Ultra', 129900), description: 'Para os projetos que precisam de mais capacidade.' },
  { ...plan('00000000-0000-4000-8000-000000000006', 'Plano personalizado', 0), description: '', currency: 'USD' },
]
const requests = []
const state = {
  accounts: [
    {
      id: 'ca_work',
      toolkit: 'github',
      label: 'GitHub · Trabalho',
      status: 'connected',
    },
    {
      id: 'ca_personal',
      toolkit: 'github',
      label: 'GitHub · Pessoal',
      status: 'connected',
    },
  ],
  purchased: false,
  modelRequests: [],
  finishModel: null,
  titleSequence: 0,
  rejectDisconnect: true,
  refreshes: 0,
  profileReads: 0,
  refreshedRequests: 0,
}
const subscription = () => ({
  id: '00000000-0000-4000-8000-000000000003',
  groupId: id,
  group: { name: 'Verboo Pro' },
  status: 'active',
  currentPeriodEnd: '2026-12-04T12:00:00Z',
  cancelAtPeriodEnd: false,
  management: { changePlan: true },
  billing: { amountMinor: 14900, currency: 'BRL', billingInterval: 'month' },
})
let challenge
const server = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) body += part
  const url = new URL(req.url, 'http://127.0.0.1')
  requests.push(req.method + ' ' + url.pathname)
  if (req.headers.authorization === 'Bearer qa-access-only-1') state.refreshedRequests++
  res.setHeader('content-type', 'application/json')
  if (url.pathname === '/api/me/usage/live-ticket' && req.method === 'POST') {
    res.end(JSON.stringify({ data: { ticket: 'qa-live-ticket', expiresAt: new Date(Date.now() + 60000).toISOString() } }))
    return
  }
  if (url.pathname === '/oauth/authorize') {
    challenge = url.searchParams.get('code_challenge')
    const callback = new URL(url.searchParams.get('redirect_uri'))
    callback.searchParams.set('state', url.searchParams.get('state'))
    callback.searchParams.set('code', 'qa-code')
    res.writeHead(302, { location: callback.href })
    res.end()
    return
  }
  if (url.pathname === '/oauth/token') {
    const params = new URLSearchParams(body)
    const refresh = params.get('grant_type') === 'refresh_token'
    const valid = refresh
      ? params.get('refresh_token') === `qa-refresh-only-${state.refreshes}`
      : createHash('sha256')
        .update(params.get('code_verifier') ?? '')
        .digest('base64url') === challenge
    if (!valid) {
      res.writeHead(400)
      res.end('{"error":"invalid_grant"}')
      return
    }
    if (refresh) state.refreshes++
    res.end(
      JSON.stringify({
        access_token: `qa-access-only-${state.refreshes}`,
        refresh_token: `qa-refresh-only-${state.refreshes}`,
        token_type: 'Bearer',
        expires_in: refresh ? 3600 : 65,
      }),
    )
    return
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  if (url.pathname === '/oauth/revoke') {
    res.end()
    return
  }
  if (url.pathname === '/api/journey/events') {
    const input = JSON.parse(body)
    res.writeHead(202)
    res.end(
      JSON.stringify({
        data: {
          receipts: input.events.map((e) => ({
            eventId: e.eventId,
            journeyId: e.journeyId,
            clientApp: '',
            payloadSha256: createHash('sha256')
              .update(input.schemaVersion + ':' + JSON.stringify(e))
              .digest('hex'),
          })),
        },
      }),
    )
    return
  }
  if (url.pathname === '/api/me') {
    state.profileReads++
    res.end(
      JSON.stringify({
        data: {
          id: other,
          name: 'Conta de demonstração',
          email: 'demo@example.invalid',
        },
      }),
    )
    return
  }
  if (url.pathname === '/router/v1/models') {
    res.end(
      JSON.stringify({
        data: [
          {
            id: 'max/qwen3.6-27b',
            display_name: 'Qwen Code',
            context_length: 262144,
            max_output_tokens: 8192,
          },
          {
            id: 'pro/deepseek-v4.1-flash',
            display_name: 'DeepSeek V4.1 Flash',
            context_length: 262144,
            max_output_tokens: 8192,
          },
        ],
      }),
    )
    return
  }
  if (url.pathname === '/router/v1/chat/completions') {
    const input = JSON.parse(body)
    state.modelRequests.push(input)
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    const chunk = (delta, finish_reason = null, usage) => res.write('data: ' + JSON.stringify({
      id: 'chatcmpl-verboo-qa', object: 'chat.completion.chunk', created: 1,
      model: input.model, choices: [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {}),
    }) + '\n\n')
    chunk({ role: 'assistant', content: '' })
    const finish = text => {
      chunk({ content: text })
      chunk({}, 'stop', { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 })
      res.end('data: [DONE]\n\n')
    }
    if (state.agentFixture?.(input, chunk, finish, res)) return
    if (JSON.stringify(input).includes('connections_list')) {
      state.finishModel = () => { finish('Pronto. Podemos começar pelo seu projeto.'); state.finishModel = null }
    } else finish(`Acesso ao MCP GitHub via Composio e revisão completa do projeto ${++state.titleSequence}`)
    return
  }
  if (url.pathname === '/api/me/stamina') { res.end(JSON.stringify({ data: [{ groupId: other, groupName: 'Verboo Pro', remainingPercent: 75, nextOutputTps: 100, recovering: false, fullAt: null, accountingPending: false, asOf: '2026-11-25T12:00:00Z' }] })); return }
  if (url.pathname === '/api/me/usage/summary' || /^\/api\/me\/groups\/[^/]+\/usage\/summary$/.test(url.pathname)) {
    res.end(JSON.stringify({ data: { timezone: 'America/Sao_Paulo', bucket: 'day', reqTotal: 4, tokensInTotal: 1000, tokensOutTotal: 300, cachedTokens: 250, buckets: [{ bucket: '2026-11-25T00:00:00-03:00', reqCount: 4, tokensIn: 1000, tokensOut: 300, cachedTokens: 250 }] } }))
    return
  }
  if (url.pathname === '/api/me/usage/activity') {
    res.end(JSON.stringify({ data: [{ date: '2026-11-25', count: 4 }] }))
    return
  }
  if (url.pathname === '/api/me/subscriptions') {
    res.end(JSON.stringify({ data: [subscription(), {
      ...subscription(), id: '00000000-0000-4000-8000-000000000007',
      group: { name: 'Plano anterior' }, status: 'canceled',
    }] }))
    return
  }
  if (url.pathname === '/api/marketplace') {
    res.end(JSON.stringify({ data: plans }))
    return
  }
  if (url.pathname === '/api/me/connections') {
    if (url.searchParams.get('catalog') !== 'all') throw new Error('Product client did not request the complete catalog')
    res.end(
      JSON.stringify({
        data: {
          available: true,
          toolkits: Object.entries(toolkitNames).map(([slug, name]) => ({
            slug,
            name,
            available: true,
            authType: slug === 'hackernews' ? 'none' : slug.startsWith('service_') ? 'credentials' : 'oauth',
          })),
          accounts: state.accounts,
        },
      }),
    )
    return
  }
  if (url.pathname === '/api/me/connections/tools/search') {
    const input = JSON.parse(body)
    if (input.connectionId !== 'ca_gmail') throw new Error('Discovery selected the wrong account')
    res.end(JSON.stringify({ data: [
      { slug: 'GMAIL_SEARCH_EMAILS', name: 'Search emails', description: 'Find messages.', version: '20240101_00', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { slug: 'GMAIL_REPLY_EMAIL', name: 'Reply to email', description: 'Reply to a message.', version: '20240101_00', parameters: { type: 'object', properties: { message_id: { type: 'string' }, body: { type: 'string' } }, required: ['message_id', 'body'] } },
    ] }))
    return
  }
  if (url.pathname === '/api/me/connections/tools/execute') {
    const input = JSON.parse(body)
    state.connectionExecutions ??= []
    state.connectionExecutions.push(input)
    const result = input.slug === 'GMAIL_SEARCH_EMAILS' ? '{"message_id":"message-1"}' : '{"sent":true}'
    res.end(JSON.stringify({ data: { successful: true, result } }))
    return
  }
  if (url.pathname === '/api/me/connections/link') {
    const input = JSON.parse(body)
    state.accounts.push({
      id: 'ca_new',
      toolkit: input.toolkit,
      label: input.label,
      status: 'pending',
    })
    res.end(
      JSON.stringify({
        data: {
          id: 'ca_new',
          url: 'https://connect.composio.dev/link/verboo-qa',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      }),
    )
    return
  }
  if (
    url.pathname.startsWith('/api/me/connections/') &&
    req.method === 'DELETE'
  ) {
    if (state.rejectDisconnect) {
      res.writeHead(503)
      res.end('{"error":"service_unavailable"}')
      return
    }
    state.accounts = state.accounts.filter(
      (a) => a.id !== url.pathname.split('/').at(-1),
    )
    res.end('{"data":{}}')
    return
  }
  if (url.pathname === '/pt/plans') {
    res.setHeader('content-type', 'text/html')
    res.end('<title>Verboo checkout QA</title><h1>Checkout de verificação</h1>')
    return
  }
  res.writeHead(404)
  res.end('{}')
})
const liveServer = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws/me/usage') { socket.destroy(); return }
  if (req.headers.origin !== `http://127.0.0.1:${server.address().port}`) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return }
  liveServer.handleUpgrade(req, socket, head, ws => {
    ws.on('message', payload => {
      try {
        const input = JSON.parse(payload.toString())
        if (input.ticket !== 'qa-live-ticket' || input.billingMode !== 'subscription') { ws.close(); return }
        const send = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'snapshot', generatedAt: new Date().toISOString(), generationRateContract: 2, generationTokensPerSecond: 123.4, generationRateQuality: 'measured', points: [] })) }
        send()
        const timer = setInterval(send, 2000)
        ws.once('close', () => clearInterval(timer))
      } catch { ws.close() }
    })
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
let hostLog = ''
function launchQaHost() {
const hostChild = spawn(
  process.execPath,
  [
    join(root, 'apps/desktop/tauri/host.mjs'),
    join(root, 'apps/cli/package.json'),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: home,
      VERBOO_API_ORIGIN: origin,
      VERBOO_ROUTER_BASE_URL: origin + '/router/v1',
      VERBOO_ALLOW_LOOPBACK_HTTP: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
)
  hostChild.stderr.on('data', chunk => { hostLog = (hostLog + chunk.toString()).slice(-20000) })
  return hostChild
}
let child = launchQaHost()
let browser
let page
let refreshedAccountFrame = false
const errors = []
const resourceFailures = []
const contrastReadings = {}
function contrastRatio(foreground, background) {
  const luminance = color => {
    if (!/^rgb\(/.test(color)) throw new Error('Contrast measurement requires an opaque RGB color')
    const channels = color.match(/[\d.]+/g).map(Number).slice(0, 3).map(value => value / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  }
  const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (levels[0] + .05) / (levels[1] + .05)
}
async function capture(name) {
  await page.evaluate(() => document.fonts.ready)
  const text = await page.locator('body').innerText()
  if (/\bDSH\b|DeepSeek Harness|\bdsh web\b/.test(text)) throw new Error('Legacy branding is visible on ' + name)
  await page.screenshot({ path: join(dir, name), animations: 'disabled' })
}
async function waitForQaHost(hostChild) {
  return await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error('QA Host readiness deadline')),
      45000,
    )
    hostChild.once('exit', (code) => reject(new Error('QA Host exited ' + code)))
    hostChild.stdout.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (!line.startsWith('VERBOO_HOST_V1\t')) continue
        const item = JSON.parse(line.slice(14))
        if (item.type === 'ready') {
          clearTimeout(timer)
          resolve(item.url)
        }
        if (item.type === 'fatal') reject(new Error('QA Host bootstrap failed'))
      }
    })
  })
}
async function restartQaHost() {
  let timer
  const exited = new Promise((resolve, reject) => {
    child.once('exit', resolve)
    timer = setTimeout(() => reject(new Error('QA Host shutdown deadline')), 16000)
  })
  child.stdin.write('{"type":"shutdown"}\n')
  try { await exited } finally { clearTimeout(timer) }
  child = launchQaHost()
  return await waitForQaHost(child)
}
try {
  const ready = await waitForQaHost(child)
  const useWebkit = process.env.VERBOO_QA_BROWSER === 'webkit'
  browser = await (useWebkit ? webkit : chromium).launch({
    ...(!useWebkit && process.env.VERBOO_QA_CHROME
      ? { executablePath: process.env.VERBOO_QA_CHROME }
      : !useWebkit && process.platform === 'darwin'
        ? {
            executablePath:
              '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          }
        : {}),
    headless: true,
  })
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'pt-BR',
    colorScheme: 'light',
  })
  if ((process.env.VERBOO_QA_PANES === '1' || process.env.VERBOO_QA_RESTORE === '1')) await context.addInitScript(() => {
    // Native capabilities are the external boundary; the real product handles the gestures.
    Object.defineProperty(window, '__VERBOO_DESKTOP__', { value: Object.freeze({
      framework: 'tauri',
      openExternal: async url => { window.open(url, '_blank') },
      quit: async () => {
        document.documentElement.dataset.qaQuitCalls = String(Number(document.documentElement.dataset.qaQuitCalls ?? 0) + 1)
      },
    }) })
  })
  await context.route('**/favicon.ico', (route) =>
    route.fulfill({ status: 204, body: '' }),
  )
  if ((process.env.VERBOO_QA_PANES === '1' || process.env.VERBOO_QA_RESTORE === '1')) await context.route('**/open-in-app/icon/**', route =>
    route.fulfill({ status: 204, body: '' }),
  )
  await context.route('https://connect.composio.dev/link/verboo-qa', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<title>Authorization QA</title><p>Connection authorized</p>',
  }))
  page = await context.newPage()
  page.on('websocket', socket => {
    socket.on('framereceived', ({ payload }) => {
      if (state.refreshes > 0 && String(payload).includes('"credentialRevision"') && String(payload).includes('"credential-stored"')) refreshedAccountFrame = true
    })
  })
  page.on('pageerror', (error) => {
    const detail = (error.stack ?? error.message).replace(/https?:\S+/g, '[url]')
    errors.push(detail)
  })
  page.on('response', response => {
    if (response.status() >= 400) resourceFailures.push(`${response.status()} ${response.url()}`)
  })
  page.on('console', (message) => {
    // Linux's generic file manager has no extractable application icon.
    if (message.location().url.endsWith('/open-in-app/icon/filemanager') && message.text().includes('404')) return
    if (['error', 'warning', 'warn'].includes(message.type()))
      errors.push(
        message
          .text()
          .replace(/https?:\S+/g, '[url]')
          .slice(0, 1000),
      )
  })
  await page.goto(new URL(ready).origin)
  errors.length = 0
  resourceFailures.length = 0
  await page.goto(ready)
  await page
    .locator('[data-verboo-onboarding]')
    .waitFor({ state: 'visible', timeout: 30000 })
  const localFont = await page.evaluate(async () => {
    const faces = await document.fonts.load('14px "Verboo Nunito"')
    return faces.length > 0 && faces.every(face => face.status === 'loaded')
  })
  if (!localFont) throw new Error('The product Nunito font did not load from the local app')
  await page.waitForTimeout(1000)
  await capture('onboarding-light.png')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await capture('onboarding-dark.png')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  await capture('onboarding-mobile.png')
  if (
    !(await page
      .getByRole('button', { name: (process.env.VERBOO_QA_PANES === '1' || process.env.VERBOO_QA_RESTORE === '1') ? 'Entrar com Verboo' : 'Continuar com Verboo', exact: true })
      .evaluate((el) => {
        const b = el.getBoundingClientRect()
        return el.contains(
          document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2),
        )
      }))
  )
    throw new Error('Mobile onboarding CTA is covered')
  await page.setViewportSize({ width: 1366, height: 900 })
  await page
    .getByRole('button', { name: (process.env.VERBOO_QA_PANES === '1' || process.env.VERBOO_QA_RESTORE === '1') ? 'Entrar com Verboo' : 'Continuar com Verboo', exact: true })
    .click()
  await page
    .locator('[data-verboo-onboarding]')
    .waitFor({ state: 'hidden', timeout: 20000 })
  if (state.refreshes !== 0) throw new Error('The QA login refreshed before the workspace was observed')
  // New Conversation keeps the user's sidebar choice and exposes both controls.
  if (await page.getByRole('button', { name: 'Abrir navegação', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Abrir navegação', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Recolher navegação', exact: true }).click()
  await page.getByRole('button', { name: 'Abrir navegação', exact: true }).click()
  await page.getByRole('button', { name: 'Analytics', exact: true }).click()
  await page.getByRole('heading', { name: 'Atividade', exact: true }).waitFor()
  await page.getByText('1.000', { exact: true }).first().waitFor()
  await page.getByRole('heading', { name: 'Stamina', exact: true }).waitFor()
  await page.getByText('123,4', { exact: true }).waitFor()
  await page.getByText('Medição atual', { exact: true }).waitFor()
  const speedCard = page.getByRole('region', { name: 'Velocidade de geração', exact: true })
  if (!(await speedCard.evaluate(element => element.scrollHeight <= element.clientHeight + 1))) throw new Error('Speed card content is clipped')
  if (await page.getByText(/requisições simultâneas|concorrência|custo equivalente/i).count()) throw new Error('Unrequested concurrency metric is visible')
  await capture('analytics.png')
  await page.locator('button[aria-label="Área de trabalho"]').click()
  await page.evaluate(() => {
    const monitor = { flashes: 0, observer: null }
    monitor.observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches('[data-verboo-onboarding]') || node.querySelector('[data-verboo-onboarding]'))) monitor.flashes++
        }
      }
    })
    monitor.observer.observe(document.body, { childList: true, subtree: true })
    window.__verbooRefreshQa = monitor
  })
  await page.waitForTimeout(700)
  await capture('workspace-light.png')
  await page.emulateMedia({colorScheme:'dark'}); await page.waitForTimeout(250); await capture('workspace-dark.png'); await page.emulateMedia({colorScheme:'light'})
  if (process.env.VERBOO_QA_RESTORE === '1') {
    const panes = page.locator('[data-pane-id]')
    const composer = panes.first().locator('[data-composer-card] [contenteditable=true]')
    await composer.fill('Sessão de teste para restauração')
    await composer.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-conversation-header]') !== null)
    const deadline = Date.now() + 20000
    while (state.finishModel === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    if (state.finishModel === null) throw new Error('The fixture did not start the test session')
    state.finishModel()
    await panes.first().getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).waitFor()
    const primary = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control')
    const saved = page.waitForResponse(response => response.ok() && (response.request().postData() ?? '').includes('paneLayout'))
    await composer.press(`${primary}+d`)
    await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 2)
    await saved
    await page.reload()
    await page.waitForFunction(() => document.querySelectorAll('[data-pane-id]').length === 2, null, { timeout: 30000 })
    await panes.first().getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).waitFor({ timeout: 30000 })
    if (errors.length) throw new Error('Browser runtime error: ' + errors[0])
    console.log('Restored signed-in session and panes after reload without startup errors.')
  } else if (process.env.VERBOO_QA_ANALYTICS === '1') {
    if (errors.length) throw new Error('Browser runtime error: ' + errors[0])
    console.log('Analytics navigation and data passed. Screenshots:', dir)
  } else if (process.env.VERBOO_QA_FOCUS === '1') {
    await verifyComposerActivation(page, state, dir)
    if (errors.length) throw new Error('Browser runtime error: ' + errors[0])
    console.log('Screenshots:', dir)
  } else if (process.env.VERBOO_QA_HEADER === '1') {
    await verifyHeaderHover(page, state, dir)
    if (errors.length) throw new Error('Browser runtime error: ' + errors[0])
    console.log('Screenshots:', dir)
  } else if (process.env.VERBOO_QA_SEND === '1') {
    await verifySendLifecycle(page, state, dir)
    if (errors.length) throw new Error('Browser runtime error: ' + errors[0])
    console.log('Screenshots:', dir)
  } else if ((process.env.VERBOO_QA_PANES === '1' || process.env.VERBOO_QA_RESTORE === '1')) {
    await verifyPanes(page, context, state, dir)
    if (errors.length) throw new Error('Browser runtime error: ' + errors[0])
    console.log('Screenshots:', dir)
  } else {
  const expandNavigation = page.getByRole('button', { name: 'Abrir navegação', exact: true })
  if (await expandNavigation.isVisible()) await expandNavigation.click()
  const composer = page.locator('[data-composer-card] [contenteditable=true]')
  const placeholderText = await composer.getAttribute('data-placeholder')
  if (!placeholderText) throw new Error('Composer placeholder is missing')
  const placeholderColors = await page.locator('[data-composer-card]').getByText(placeholderText, { exact: true }).evaluate(el => ({
    foreground: getComputedStyle(el).color,
    background: getComputedStyle(el.closest('[data-composer-card]')).backgroundColor,
  }))
  contrastReadings.placeholderLight = contrastRatio(placeholderColors.foreground, placeholderColors.background)
  if (contrastReadings.placeholderLight < 4.5) throw new Error('Composer placeholder contrast is below 4.5:1')
  await composer.fill('Vamos começar um projeto simples.')
  await composer.press('Enter')
  await page.locator('[data-verboo-running]').waitFor({ timeout: 30000 })
  await page.locator('[data-verboo-session][data-state=working]').waitFor()
  if (await page.locator('[data-verboo-execution=working]').count()) throw new Error('Working label remains in the composer')
  await capture('conversation-running.png')
  const refreshDraft = 'Continuar daqui depois da renovação.'
  await composer.fill(refreshDraft)
  await page.evaluate(() => {
    window.__verbooRefreshQa.editor = document.querySelector('[data-composer-card] [contenteditable=true]')
    window.__verbooRefreshQa.session = document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session')
  })
  const refreshDeadline = Date.now() + 15000
  while ((state.refreshes === 0 || state.refreshedRequests === 0 || !refreshedAccountFrame) && Date.now() < refreshDeadline) await new Promise(resolve => setTimeout(resolve, 50))
  if (state.refreshes !== 1 || state.refreshedRequests === 0 || !refreshedAccountFrame) throw new Error('The live app did not observe and use the rotated login')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const refreshUi = await page.evaluate(() => {
    const monitor = window.__verbooRefreshQa
    const result = {
      flashes: monitor.flashes,
      sameEditor: monitor.editor === document.querySelector('[data-composer-card] [contenteditable=true]'),
      focused: monitor.editor === document.activeElement,
      draft: monitor.editor?.textContent,
      sameSession: monitor.session === document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session'),
      stillWorking: document.querySelector('[data-verboo-session][data-state=working]') !== null,
    }
    monitor.observer.disconnect()
    delete window.__verbooRefreshQa
    return result
  })
  if (refreshUi.flashes || !refreshUi.sameEditor || !refreshUi.focused || refreshUi.draft !== refreshDraft || !refreshUi.sameSession || !refreshUi.stillWorking || state.profileReads !== 1) throw new Error('Token refresh interrupted the workspace: ' + JSON.stringify({ ...refreshUi, profileReads: state.profileReads }))
  await composer.fill('')
  console.log('Live token refresh: rotated credentials, no onboarding flash, retained draft, focus, conversation and running state.')
  const inferenceDeadline = Date.now() + 30000
  while (state.finishModel === null && Date.now() < inferenceDeadline) await new Promise(resolve => setTimeout(resolve, 50))
  const modelInput = JSON.stringify(state.modelRequests)
  if (!modelInput.includes('You are Verboo Code') || modelInput.includes('You are an AI agent powered by DeepSeek Harness')) throw new Error('Agent product identity mismatch')
  for (const tool of ['connections_list', 'connections_search']) {
    if (!modelInput.includes(tool)) throw new Error('Connection tool missing in the shipped Agent: ' + tool)
  }
  if (!state.finishModel) throw new Error('Chat did not reach the configured inference gateway')
  state.finishModel()
  await page.getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).waitFor()
  await page.locator('[data-chat-running]').waitFor({ state: 'hidden' })
  await page.locator('[data-verboo-session]:has([aria-current=page])[data-state=idle]').waitFor()
  state.accounts.push({ id: 'ca_gmail', toolkit: 'gmail', label: 'Gmail QA', status: 'connected' })
  state.connectionExecutions = []
  state.agentFixture = (input, chunk, finish, response) => {
    const start = input.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('QA_GMAIL_DISCOVERY'))
    if (start < 0) return false
    const results = input.messages.slice(start + 1).filter(message => message.role === 'tool')
    const actions = [
      ['connections_search', { query: 'find and reply to an email', toolkit: 'gmail' }],
      ['connection__gmail__GMAIL_SEARCH_EMAILS', {}],
      ['connection__gmail__GMAIL_SEARCH_EMAILS', { query: 'from:ana' }],
      ['connection__gmail__GMAIL_REPLY_EMAIL', { message_id: 'message-1', body: 'Obrigado!' }],
    ]
    if (results.length === 1) {
      const declared = JSON.stringify(input.tools)
      if (!declared.includes('GMAIL_SEARCH_EMAILS') || !declared.includes('GMAIL_REPLY_EMAIL') || !declared.includes('message_id')) throw new Error('Discovered Gmail tools or their parameters were not declared')
    }
    if (results.length === 2 && (!JSON.stringify(results[1]).includes('invalid arguments') || state.connectionExecutions.length !== 0)) throw new Error('Invalid provider arguments were not rejected before execution')
    if (results.length >= actions.length) {
      finish('QA_GMAIL_DONE')
      return true
    }
    const [name, args] = actions[results.length]
    chunk({ tool_calls: [{ index: 0, id: `call_gmail_${results.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
    response.end('data: [DONE]\n\n')
    return true
  }
  await composer.fill('QA_GMAIL_DISCOVERY')
  await composer.press('Enter')
  await page.getByText('QA_GMAIL_DONE', { exact: true }).waitFor()
  if (state.connectionExecutions.length !== 2 || state.connectionExecutions[0].slug !== 'GMAIL_SEARCH_EMAILS' || state.connectionExecutions[1].slug !== 'GMAIL_REPLY_EMAIL' || state.connectionExecutions.some(call => call.connectionId !== 'ca_gmail')) throw new Error('Gmail discovery and execution did not use the selected account')
  console.log('Connection QA: Gmail search and reply were declared and executed in one turn with the selected account.')
  state.agentFixture = null
  state.accounts = state.accounts.filter(account => account.id !== 'ca_gmail')
  if (await page.locator('[data-verboo-execution]').count()) throw new Error('Idle composer occupies space')
  await capture('conversation-complete.png')
  await page.locator('[data-chat-assistant-mark] img').first().waitFor({ state: 'hidden' })
  if (await page.locator('[data-composer-stat]').count()) throw new Error('Diagnostic statistics remain in the product composer')
  if (await page.locator('[data-composer-dock]').getByRole('button', { name: /contexto|context used/i }).count()) throw new Error('Context diagnostics remain in the product composer')
  if (await page.getByRole('tab', { name: /Trajetória|Trajectory/ }).count()) throw new Error('Diagnostic views remain in the product header')
  const bubbleColors = await page.locator('[data-message-bubble]').first().evaluate(el => {
    const style = getComputedStyle(el)
    return { foreground: style.color, fill: style.backgroundColor }
  })
  const bubbleFill = bubbleColors.fill.match(/[\d.]+/g).map(Number)
  contrastReadings.userMessage = contrastRatio(bubbleColors.foreground, bubbleColors.fill)
  if (Math.max(...bubbleFill.slice(0, 3)) - Math.min(...bubbleFill.slice(0, 3)) > 8 || contrastReadings.userMessage < 4.5) throw new Error('User message lost its neutral surface or readable foreground')
  await composer.click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await capture('conversation-dark.png')
  await page.emulateMedia({ colorScheme: 'light' })
  await capture('conversation-light.png')
  const findConversation = page.getByRole('button', { name: 'Buscar projeto ou conversa', exact: true })
  await findConversation.click()
  const conversationSearch = page.getByRole('textbox', { name: 'Buscar projeto ou conversa', exact: true })
  await conversationSearch.fill('verboo-no-matching-project')
  if (await page.locator('[data-verboo-session]').count()) throw new Error('Project search did not filter conversations')
  await conversationSearch.fill('')
  await findConversation.click()
  await page.locator('[data-verboo-session]').first().waitFor()
  for (let index = 0; index < 2; index++) {
    const previousSession = await page.locator('[data-conversation-session]').getAttribute('data-conversation-session')
    await page.getByRole('button', { name: 'Nova conversa', exact: true }).first().click()
    await page.waitForFunction(previous => {
      const content = document.querySelector('[data-conversation-session]'), selected = document.querySelector('[data-verboo-session]:has([aria-current=page])')
      return content && selected && content.getAttribute('data-conversation-session') !== previous && content.getAttribute('data-conversation-session') === selected.getAttribute('data-verboo-session')
    }, previousSession)
    await page.getByRole('heading', { name: 'O que vamos construir?', exact: true }).waitFor()
    await composer.fill(`Revisar o projeto e as conexões ${index}.`)
    await composer.press('Enter')
    await page.locator('[data-verboo-session]:has([aria-current=page])[data-state=working] [role=status]').waitFor()
    const deadline = Date.now() + 30000
    while (state.finishModel === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    if (state.finishModel === null) throw new Error('Additional conversation did not reach inference')
    if (index === 1) {
      const rows = page.locator('[data-verboo-session]')
      await page.waitForFunction(() => document.querySelectorAll('[data-verboo-session]').length >= 3)
      await rows.filter({ has: page.locator('[aria-current=page]') }).waitFor()
      await page.emulateMedia({ colorScheme: 'dark' })
      const idle = page.locator('[data-verboo-session][data-state=idle]').first()
      await idle.hover()
      const geometry = await rows.evaluateAll(items => items.map(item => {
        const row = item.getBoundingClientRect(), title = item.querySelector('button[title]'), menu = item.querySelector('button[aria-label]')
        const action = menu.getBoundingClientRect(), main = title.getBoundingClientRect(), indicator = item.querySelector('[role=status]')
        return { x: row.x, y: row.y, bottom: row.bottom, right: row.right, height: row.height, actionRight: action.right, mainRight: main.right, actionLeft: action.left, innerBackground: getComputedStyle(title).backgroundColor, working: item.getAttribute('data-state') === 'working', indicator: indicator !== null, title: title.textContent }
      }))
      for (let i = 0; i < geometry.length; i++) {
        const row = geometry[i]
        if (row.height < 28 || row.height > 32 || row.actionRight > row.right + 1 || row.mainRight > row.actionLeft + 1) throw new Error('Sidebar density or title/menu overlap')
        if (i > 0 && row.y < geometry[i - 1].bottom) throw new Error('Conversation rows overlap')
        if (row.indicator !== row.working || /Idle|Parado/.test(row.title)) throw new Error('Inactive sidebar chrome or missing working indicator')
        if (row.innerBackground !== 'rgba(0, 0, 0, 0)') throw new Error('Nested conversation selection background')
      }
      await capture('sidebar-states-dark.png')
      await page.emulateMedia({ colorScheme: 'light' })
      await capture('sidebar-states-light.png')
      const touch = await context.newCDPSession(page)
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      await page.setViewportSize({ width: 390, height: 844 })
      if (!await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) throw new Error('Touch media query was not enabled')
      await page.locator('[data-sidebar-drawer=true][data-sidebar-collapsed=true]').waitFor()
      await page.locator('[data-sidebar-opener]').click()
      await page.locator('[data-verboo-shell][data-wide=true]').waitFor()
      await page.waitForFunction(() => Math.abs(document.querySelector('[data-verboo-shell]').parentElement.getBoundingClientRect().x) < 1)
      await capture('sidebar-states-mobile.png')
      const mobileRows = await page.locator('[data-verboo-session]').evaluateAll(items => items.map(item => {
        const row = item.getBoundingClientRect(), menu = item.querySelector('button[aria-label]').getBoundingClientRect()
        return { row: row.right, menu: menu.right }
      }))
      if (mobileRows.some(item => item.menu > item.row + 1)) throw new Error('Mobile conversation menu overflows its row')
      await page.getByRole('button', { name: 'Recolher navegação', exact: true }).click()
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await touch.detach()
      await page.setViewportSize({ width: 1366, height: 900 })
    }
    state.finishModel()
    await page.locator('[data-verboo-session]:has([aria-current=page])[data-state=idle]').waitFor()
    if (await page.locator('[data-verboo-session] [role=status]').count()) throw new Error('Conversation spinner remained after completion')
  }
  await page.getByRole('button', { name: 'Conexões', exact: true }).click()
  await page.locator('[data-verboo-page=connections]').waitFor()
  const catalog = page.locator('[data-verboo-page=connections] section').filter({ hasText: 'Serviços disponíveis' }).first()
  await catalog.getByRole('group', { name: 'Filtrar por categoria' }).waitFor()
  await page.getByText('1718 serviços', { exact: true }).waitFor()
  if (await catalog.locator('article').count()) throw new Error('Connector catalog opened before category selection or search')
  const search = page.getByRole('textbox', { name: 'Buscar um serviço' })
  await search.fill('service_')
  await catalog.getByRole('heading', { name: 'Service 0000', exact: true }).waitFor()
  if (await catalog.locator('article').count() !== 40) throw new Error('Connector catalog rendered without paging')
  await catalog.getByRole('button', { name: 'Mostrar mais', exact: true }).click()
  if (await catalog.locator('article').count() !== 80) throw new Error('Connector paging did not advance')
  await search.fill('service_1708')
  await page.getByRole('heading', { name: 'Service 1708', exact: true }).waitFor()
  if (await page.locator('[data-verboo-page=connections] article').count() !== 1) throw new Error('Search did not cover the full connector catalog')
  await search.fill('Hacker News')
  await catalog.getByRole('heading', { name: 'Hacker News', exact: true }).waitFor()
  await page.getByText('Disponível', { exact: true }).waitFor()
  if (await page.getByRole('button', { name: 'Conectar Hacker News', exact: true }).count()) throw new Error('Public service asks for credentials')
  await search.fill('')
  await capture('connections-light.png')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(200)
  await capture('connections-dark.png')
  await search.fill('service_')
  await catalog.getByRole('heading', { name: 'Service 0000', exact: true }).waitFor()
  const catalogTouch = await context.newCDPSession(page)
  await catalogTouch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-drawer=true]').waitFor()
  if (await page.locator('[data-sidebar-drawer=true]').getAttribute('data-sidebar-collapsed') !== 'true') {
    await page.locator('[data-sidebar-toggle]').click()
    await page.locator('[data-sidebar-drawer=true][data-sidebar-collapsed=true]').waitFor()
  }
  await page.locator('[data-verboo-shell]').waitFor({ state: 'hidden' })
  const touchTargets = await catalog.locator('article button').evaluateAll(items => items.map(item => ({ width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height })))
  if (!touchTargets.length) throw new Error('No connector actions were checked on mobile')
  if (touchTargets.some(item => item.width < 44 || item.height < 44)) throw new Error('Connector touch target is smaller than 44px')
  await capture('connections-mobile.png')
  const catalogOverflow = await page.locator('[data-verboo-page=connections]').evaluate(el => ({
    width: el.clientWidth, scrollWidth: el.scrollWidth,
    overflowing: [...el.querySelectorAll('*')].filter(item => item.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).slice(0, 8).map(item => ({ tag: item.tagName, className: item.className, right: item.getBoundingClientRect().right })),
  }))
  if (catalogOverflow.scrollWidth > catalogOverflow.width) throw new Error('Connector catalog overflows on mobile: ' + JSON.stringify(catalogOverflow))
  await catalogTouch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await catalogTouch.detach()
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await search.fill('Notion')
  await page
    .getByRole('button', { name: 'Conectar Notion', exact: true })
    .click()
  await page.getByRole('dialog', { name: 'Conectar um serviço' }).waitFor()
  await page
    .getByLabel('Nome da conexão', { exact: true })
    .fill('Notion · Trabalho')
  await page.waitForTimeout(250)
  await capture('connect-dialog.png')
  const authorization = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Continuar no navegador', exact: true }).click()
  const provider = await authorization
  await provider.waitForLoadState('domcontentloaded')
  await page.getByRole('dialog', { name: 'Conectar um serviço' }).waitFor({ state: 'hidden' })
  state.accounts.find(a => a.id === 'ca_new').status = 'connected'
  await provider.close()
  await page.getByRole('button', { name: 'Atualizar', exact: true }).first().click()
  await page.getByText('Notion · Trabalho', { exact: true }).waitFor()
  const accounts = page.locator('[data-verboo-page=connections] section').filter({ has: page.getByRole('heading', { name: 'Contas conectadas', exact: true }) })
  const newRow = accounts.locator(':scope > div > div').filter({ has: page.getByText('Notion · Trabalho', { exact: true }) })
  await newRow.getByRole('button', { name: /Desconectar/ }).click()
  const disconnect = page.getByRole('dialog', { name: 'Desconectar esta conta?' })
  await disconnect.waitFor()
  await disconnect.getByRole('button', { name: 'Desconectar conta', exact: true }).click()
  await disconnect.getByRole('alert').waitFor()
  if (await page.getByText('Conexão removida.', { exact: true }).count()) throw new Error('Stale success overlaps a disconnect failure')
  await capture('disconnect-error.png')
  state.rejectDisconnect = false
  await disconnect.getByRole('button', { name: 'Desconectar conta', exact: true }).click()
  await disconnect.waitFor({ state: 'hidden' })
  await page.getByText('Notion · Trabalho', { exact: true }).waitFor({ state: 'hidden' })
  if (!state.accounts.some(a => a.id === 'ca_work') || !state.accounts.some(a => a.id === 'ca_personal')) {
    throw new Error('Disconnecting one account changed another connection')
  }
  await page.getByRole('button', { name: 'Meu plano', exact: true }).click()
  await page.locator('[data-verboo-page=plan]').waitFor()
  await page
    .getByRole('heading', { name: 'Verboo Pro', exact: true })
    .first()
    .waitFor()
  await page
    .getByRole('button', { name: 'Meu plano', exact: true })
    .and(page.locator('[aria-current=page]'))
    .waitFor()
  await page.waitForTimeout(250)
  if (await page.getByText('Conexão removida.', { exact: true }).count()) throw new Error('Connection feedback survived page navigation')
  await capture('plan-light.png')
  const planPage = page.locator('[data-verboo-page=plan]')
  const planButtonColors = await planPage.locator('[data-current=false] button').evaluateAll(items => items.map(el => ({
    foreground: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor,
  })))
  contrastReadings.planButtons = Math.min(...planButtonColors.map(colors => contrastRatio(colors.foreground, colors.background)))
  if (!planButtonColors.length || contrastReadings.planButtons < 4.5) throw new Error('Plan action contrast is below 4.5:1')
  if (await planPage.getByRole('tablist').count()) throw new Error('Billing switch is shown without annual offers')
  if (!await planPage.getByRole('button', { name: 'Plano atual: Verboo Pro', exact: true }).isDisabled()) throw new Error('Current plan can be repurchased')
  if (await planPage.locator('details').evaluate(el => el.open)) throw new Error('Subscription history is expanded by default')
  const cards = await planPage.locator('[data-current]').evaluateAll(items => items.map(el => {
    const box = el.getBoundingClientRect(), button = el.querySelector('button').getBoundingClientRect()
    return { top: box.top, right: box.right, left: box.left, width: box.width, buttonTop: button.top, buttonRight: button.right }
  }))
  if (cards.length !== 4 || cards.some(item => item.width < 200 || item.buttonRight > item.right)) throw new Error('Plan cards are missing or overflow')
  if (cards.some(item => Math.abs(item.top - cards[0].top) > 1 || Math.abs(item.buttonTop - cards[0].buttonTop) > 1)) throw new Error('Desktop plan comparison or actions are not aligned')
  await page.emulateMedia({ colorScheme: 'dark' })
  await capture('plan-dark.png')
  await page.setViewportSize({ width: 1024, height: 900 })
  await capture('plan-compact.png')
  const planTouch = await context.newCDPSession(page)
  await planTouch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-drawer=true][data-sidebar-collapsed=true]').waitFor()
  await page.locator('[data-verboo-shell]').waitFor({ state: 'hidden' })
  for (const theme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: theme })
    await capture(`plan-mobile-${theme}.png`)
    if (await planPage.evaluate(el => el.scrollWidth > el.clientWidth)) throw new Error('Plan comparison overflows on mobile')
    const targets = await planPage.locator('button:visible').evaluateAll(items => items.map(el => el.getBoundingClientRect().height))
    if (targets.some(height => height < 44)) throw new Error('Subscription action is smaller than a touch target')
  }
  await planTouch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await planTouch.detach()
  await page.setViewportSize({ width: 1366, height: 900 })
  const managementPopup = page.waitForEvent('popup')
  await planPage.getByRole('button', { name: 'Gerenciar assinatura: Verboo Pro', exact: true }).click()
  const management = await managementPopup
  await management.waitForURL(u => u.pathname === '/pt/plans')
  await management.close()
  const popup = page.waitForEvent('popup')
  await planPage.getByRole('button', { name: 'Escolher plano: Verboo Max', exact: true }).click()
  const checkout = await popup
  await checkout.waitForURL((u) => u.pathname === '/pt/plans')
  await checkout.waitForLoadState('domcontentloaded')
  if (new URL(checkout.url()).pathname !== '/pt/plans')
    throw new Error('Billing handoff destination mismatch')
  await checkout.close()
  await page.getByRole('button', { name: 'Preferências', exact: true }).click()
  await page.locator('[data-verboo-page=preferences]').waitFor()
  await capture('preferences-light.png')
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click()
  await page.getByRole('dialog', { name: 'Sair do Verboo Code?' }).waitFor()
  await page.waitForTimeout(250)
  await capture('signout-dialog.png')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  await page.waitForTimeout(300)
  await capture('preferences-mobile.png')
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error('Mobile viewport overflow')
  if (errors.length) throw new Error('Browser runtime error: ' + errors[0])
  await writeFile(join(dir, 'contrast.json'), JSON.stringify(contrastReadings, null, 2) + '\n')
  console.log('Measured contrast:', JSON.stringify(contrastReadings))
  console.log(
    'Actual Verboo profile browser QA: OAuth PKCE, live token refresh, vault, conversation execution states, non-overlapping sidebar rows, 1718 searchable connectors, public services, connection tool composition, no legacy branding, navigation, plan handoff, accessible dialogs, both palettes and 390px passed.',
  )
  console.log('Screenshots:', dir)
  }
} catch (error) {
  await writeFile(join(dir, 'host-diagnostic.log'), hostLog)
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(dir, 'failure.png') })
    console.log(
      'Failure surface:',
      (await page.locator('body').innerText())
        .slice(0, 900)
        .replace(/https?:\S+/g, '[url]'),
    )
    console.log(
      'Runtime errors:',
      errors.map((v) => v.slice(0, 1000)),
    )
    console.log('API routes:', requests)
    console.log('HTTP resource failures:', resourceFailures)
  }
  console.error((error.stack ?? error.message).replace(/https?:\S+/g, '[url]'))
  process.exitCode = 1
} finally {
  state.finishModel?.()
  if (browser) await browser.close()
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise(resolve => child.once('exit', resolve))
  child.stdin.write('{"type":"shutdown"}\n')
  const stopHost = setTimeout(() => child.kill('SIGTERM'), 16000).unref()
  const killHost = setTimeout(() => child.kill('SIGKILL'), 19000).unref()
  await exited
  clearTimeout(stopHost)
  clearTimeout(killHost)
  await writeFile(join(dir, 'host-diagnostic.log'), hostLog)
  for (const socket of liveServer.clients) socket.terminate()
  liveServer.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  try {
    const r = createRequire(
      join(root, 'packages/credentials/verboo-account/package.json'),
    )
    const { AsyncEntry } = r('@napi-rs/keyring')
    const entry = new AsyncEntry(
      'Verboo Code Desktop',
      createHash('sha256')
        .update(origin + '\n' + home)
        .digest('hex'),
    )
    await entry.deleteCredential()
  } catch {}
  await rm(home, { recursive: true, force: true })
}
