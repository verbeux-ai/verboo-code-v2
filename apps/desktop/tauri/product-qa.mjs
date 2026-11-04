/** Exercise the shipped Verboo profile with external HTTP fixtures and a temporary OS credential. Run from the repository root after build:artifacts. */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = process.cwd(),
  require = createRequire(join(root, 'apps/web/package.json'))
const { chromium } = require('playwright')
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
const plans = [plan(id, 'Verboo Pro', 14900), plan(other, 'Verboo Max', 29900)]
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
  res.setHeader('content-type', 'application/json')
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
    if (
      createHash('sha256')
        .update(params.get('code_verifier') ?? '')
        .digest('base64url') !== challenge
    ) {
      res.writeHead(400)
      res.end('{"error":"invalid_grant"}')
      return
    }
    res.end(
      JSON.stringify({
        access_token: 'qa-access-only',
        refresh_token: 'qa-refresh-only',
        token_type: 'Bearer',
        expires_in: 3600,
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
            context_length: 65536,
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
      model: 'max/qwen3.6-27b', choices: [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {}),
    }) + '\n\n')
    chunk({ role: 'assistant', content: '' })
    const finish = text => {
      chunk({ content: text })
      chunk({}, 'stop', { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 })
      res.end('data: [DONE]\n\n')
    }
    if (JSON.stringify(input).includes('connections_list')) {
      state.finishModel = () => { finish('Pronto. Podemos começar pelo seu projeto.'); state.finishModel = null }
    } else finish(`Acesso ao MCP GitHub via Composio e revisão completa do projeto ${++state.titleSequence}`)
    return
  }
  if (url.pathname === '/api/me/stamina') { res.end(JSON.stringify({data:[]})); return }
  if (url.pathname === '/api/me/subscriptions') {
    res.end(JSON.stringify({ data: [subscription()] }))
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
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
const child = spawn(
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
child.stderr.on('data', () => {})
let browser
let page
const errors = []
async function capture(name) {
  const text = await page.locator('body').innerText()
  if (/\bDSH\b|DeepSeek Harness|\bdsh web\b/.test(text)) throw new Error('Legacy branding is visible on ' + name)
  await page.screenshot({ path: join(dir, name) })
}
try {
  const ready = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error('QA Host readiness deadline')),
      45000,
    )
    child.once('exit', (code) => reject(new Error('QA Host exited ' + code)))
    child.stdout.on('data', (chunk) => {
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
  browser = await chromium.launch({
    ...(process.env.VERBOO_QA_CHROME
      ? { executablePath: process.env.VERBOO_QA_CHROME }
      : process.platform === 'darwin'
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
  await context.route('**/favicon.ico', (route) =>
    route.fulfill({ status: 204, body: '' }),
  )
  await context.route('https://connect.composio.dev/link/verboo-qa', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<title>Authorization QA</title><p>Connection authorized</p>',
  }))
  page = await context.newPage()
  page.on('pageerror', (error) =>
    errors.push(error.message.replace(/https?:\S+/g, '[url]')),
  )
  page.on('console', (message) => {
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
  await page.goto(ready)
  await page
    .locator('[data-verboo-onboarding]')
    .waitFor({ state: 'visible', timeout: 30000 })
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
      .getByRole('button', { name: 'Continuar com Verboo', exact: true })
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
    .getByRole('button', { name: 'Continuar com Verboo', exact: true })
    .click()
  await page
    .locator('[data-verboo-onboarding]')
    .waitFor({ state: 'hidden', timeout: 20000 })
  await page.waitForTimeout(700)
  await capture('workspace-light.png')
  await page.emulateMedia({colorScheme:'dark'}); await page.waitForTimeout(250); await capture('workspace-dark.png'); await page.emulateMedia({colorScheme:'light'})
  const composer = page.locator('[data-composer-card] [contenteditable=true]')
  await composer.fill('Vamos começar um projeto simples.')
  await composer.press('Enter')
  await page.locator('[data-verboo-running]').waitFor({ timeout: 30000 })
  await page.locator('[data-verboo-execution=working]').waitFor()
  await page.locator('[data-verboo-session][data-state=working]').waitFor()
  await capture('conversation-running.png')
  const inferenceDeadline = Date.now() + 30000
  while (state.finishModel === null && Date.now() < inferenceDeadline) await new Promise(resolve => setTimeout(resolve, 50))
  const modelInput = JSON.stringify(state.modelRequests)
  if (!modelInput.includes('You are Verboo Code') || modelInput.includes('You are an AI agent powered by DeepSeek Harness')) throw new Error('Agent product identity mismatch')
  for (const tool of ['connections_list', 'connections_search', 'connections_execute']) {
    if (!modelInput.includes(tool)) throw new Error('Connection tool missing in the shipped Agent: ' + tool)
  }
  if (!state.finishModel) throw new Error('Chat did not reach the configured inference gateway')
  state.finishModel()
  await page.getByText('Pronto. Podemos começar pelo seu projeto.', { exact: true }).waitFor()
  await page.locator('[data-chat-running]').waitFor({ state: 'hidden' })
  await page.locator('[data-verboo-session]:has([aria-current=page])[data-state=idle]').waitFor()
  if (await page.locator('[data-verboo-execution]').count()) throw new Error('Idle composer occupies space')
  await capture('conversation-complete.png')
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
    await page.locator('[data-verboo-execution=working]').waitFor()
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
  await page.getByRole('heading', { name: 'GitHub', exact: true }).waitFor()
  await page.getByText('1718 serviços', { exact: true }).waitFor()
  if (await page.locator('[data-verboo-page=connections] article').count() !== 40) throw new Error('Connector catalog rendered without paging')
  await page.getByRole('button', { name: 'Mostrar mais', exact: true }).click()
  if (await page.locator('[data-verboo-page=connections] article').count() !== 80) throw new Error('Connector paging did not advance')
  const search = page.getByRole('textbox', { name: 'Buscar um serviço' })
  await search.fill('service_1708')
  await page.getByRole('heading', { name: 'Service 1708', exact: true }).waitFor()
  if (await page.locator('[data-verboo-page=connections] article').count() !== 1) throw new Error('Search did not cover the full connector catalog')
  await search.fill('Hacker News')
  await page.getByText('Não exige credenciais', { exact: true }).waitFor()
  await page.getByText('Disponível', { exact: true }).waitFor()
  if (await page.getByRole('button', { name: 'Conectar Hacker News', exact: true }).count()) throw new Error('Public service asks for credentials')
  await search.fill('')
  await capture('connections-light.png')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(200)
  await capture('connections-dark.png')
  const catalogTouch = await context.newCDPSession(page)
  await catalogTouch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-drawer=true]').waitFor()
  if (await page.locator('[data-sidebar-drawer=true]').getAttribute('data-sidebar-collapsed') !== 'true') {
    await page.locator('[data-sidebar-toggle]').click()
    await page.locator('[data-sidebar-drawer=true][data-sidebar-collapsed=true]').waitFor()
  }
  await page.locator('[data-verboo-shell]').waitFor({ state: 'hidden' })
  const touchTargets = await page.locator('[data-verboo-page=connections] article button').evaluateAll(items => items.map(item => ({ width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height })))
  if (touchTargets.some(item => item.width < 44 || item.height < 44)) throw new Error('Connector touch target is smaller than 44px')
  await capture('connections-mobile.png')
  const catalogOverflow = await page.locator('[data-verboo-page=connections]').evaluate(el => el.scrollWidth > el.clientWidth)
  if (catalogOverflow) throw new Error('Connector catalog overflows on mobile')
  await catalogTouch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await catalogTouch.detach()
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
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
  const newRow = page.locator('[data-verboo-page=connections] section > div > div').filter({ hasText: 'Notion · Trabalho' }).last()
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
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Fazer upgrade', exact: true }).click()
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
  console.log(
    'Actual Verboo profile browser QA: OAuth PKCE, vault, conversation execution states, non-overlapping sidebar rows, 1718 searchable connectors, public services, connection tool composition, no legacy branding, navigation, plan handoff, accessible dialogs, both palettes and 390px passed.',
  )
  console.log('Screenshots:', dir)
} catch (error) {
  if (page) {
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
  }
  console.error(error.message.replace(/https?:\S+/g, '[url]'))
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  child.stdin.write('{"type":"shutdown"}\n')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        child.kill('SIGTERM')
        resolve()
      }, 16000),
    ),
  ])
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
