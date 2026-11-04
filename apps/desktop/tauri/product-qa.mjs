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
    } else finish('Projeto simples')
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
    res.end(
      JSON.stringify({
        data: {
          available: true,
          toolkits: Object.entries(toolkitNames).map(([slug, name]) => ({
            slug,
            name,
            available: true,
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
  await capture('conversation-complete.png')
  await page.getByRole('button', { name: 'Conexões', exact: true }).click()
  await page.locator('[data-verboo-page=connections]').waitFor()
  await page.getByRole('heading', { name: 'GitHub', exact: true }).waitFor()
  await capture('connections-light.png')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(200)
  await capture('connections-dark.png')
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
    'Actual Verboo profile browser QA: OAuth PKCE, vault, conversation, connection tool composition, no legacy branding, navigation, plan handoff, accessible dialogs, both palettes and 390px passed.',
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
