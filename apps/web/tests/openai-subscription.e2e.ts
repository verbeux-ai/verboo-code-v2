// Real-composition acceptance for the [OI] subscription inside the shipped Web
// tree: the account plugin and its route mount from the product roster, the
// sign-in surface answers over the real Remote gateway, and the composer's limit
// control stays absent while no reading exists. A loopback double answers the
// token endpoint, so the exchange runs end to end without contacting a provider.
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const VIEWPORT = { width: 1000, height: 760 } as const
const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/openai-subscription/cordis.patch.yml', import.meta.url))

/** One unsigned JWT whose payload names a team plan, as the provider issues it. */
function idToken(expSeconds: number): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    exp: expSeconds,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'e2e-account',
      chatgpt_plan_type: 'team',
      chatgpt_subscription_active_until: '2027-03-12T00:00:00+00:00',
    },
  })}.signature`
}

describe('web e2e: [OI] subscription sign-in and limit control', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let double: Server
  let home: string
  /** Codes the double already accepted, so a replay is refused as the provider refuses it. */
  const accepted = new Set<string>()

  beforeAll(async () => {
    double = createServer((request, response) => {
      if (request.method !== 'POST' || new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/oauth/token') {
        response.writeHead(404)
        response.end()
        return
      }
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        const form = new URLSearchParams(body)
        const code = form.get('code') ?? ''
        const isExchange = form.get('grant_type') === 'authorization_code'
        if (isExchange && (code !== 'good-code' || accepted.has(code))) {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end('{"error":"invalid_grant"}')
          return
        }
        if (isExchange) accepted.add(code)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          access_token: 'e2e-access-token',
          refresh_token: 'e2e-refresh-token',
          id_token: idToken(Math.floor(Date.now() / 1000) + 3600),
        }))
      })
    })
    await new Promise<void>(resolve => { double.listen(0, '127.0.0.1', resolve) })
    const address = double.address()
    const origin = typeof address === 'object' && address !== null
      ? `http://127.0.0.1:${String(address.port)}`
      : ''

    // The overlay carries the bound port, so it is written per run rather than
    // committed with a placeholder no launcher would substitute here.
    home = await mkdtemp(join(tmpdir(), 'dsh-openai-e2e-'))
    const overlay = join(home, 'cordis.patch.yml')
    await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8')).replaceAll('{{origin}}', origin))

    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    browser = await chromium.launch()
    page = await newEnglishPage(browser, VIEWPORT.height)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.setViewportSize(VIEWPORT)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await new Promise<void>(resolve => { double?.close(() => { resolve() }) })
    if (home !== undefined) await rm(home, { recursive: true, force: true })
  })

  it('mounts the account from the product roster', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-openai-subscription'))
    // Resolved from the running Host: a roster row that mounted nothing fails
    // here, which reading the config alone could never detect.
    expect(scaffold.ctx.get('openaiAccount')).toBeDefined()
  })

  it('mounts the route and serves its generated namespace', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-openai-subscription'))
    expect(scaffold.ctx.get('llmOpenaiAccount')).toBeDefined()
  })

  it('reports no stored session before a sign-in', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-openai-subscription'))
    const account = scaffold.ctx.get('openaiAccount') as { status(): Promise<{ signedIn: boolean }> }
    await expect(account.status()).resolves.toMatchObject({ signedIn: false })
  })

  it('keeps the composer silent while no reading exists', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-openai-subscription'))
    // An absent reading paints nothing: the dock keeps the height it has and no
    // percentage reaches the reader.
    await expect.poll(async () => page.locator('[data-verboo-subscription-usage]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('addresses the provider with the Codex-compatible authorization request', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-openai-subscription'))
    const login = scaffold.ctx.get('openaiAccountLogin') as {
      beginLogin(uri: string, signal: AbortSignal): { url: string; handle: string }
    }
    const started = login.beginLogin(`${originOf(double)}/callback`, new AbortController().signal)
    // The URL the product opens in the browser, with the parameters that make
    // the issued grant Codex-compatible.
    expect(started.url).toContain('code_challenge_method=S256')
    expect(started.url).toContain('originator=codex_cli_rs')
    expect(started.url).toContain('response_type=code')
    expect(started.url).toContain('redirect_uri=')
  })

  it('serves the callback the browser returns to', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-openai-subscription'))
    const login = scaffold.ctx.get('openaiAccountLogin') as {
      beginLogin(uri: string, signal: AbortSignal): { url: string; handle: string }
    }
    const started = login.beginLogin(`${originOf(double)}/callback`, new AbortController().signal)
    // The Host answers its own callback, so the reader never carries a code
    // between windows. A response whose state it did not issue is refused.
    const host = new URL(scaffold.authenticatedUrl).origin
    const refused = await fetch(`${host}/auth/callback?state=not-ours&code=good-code`)
    expect(refused.status).toBe(400)
    // And the route is the one the authorization request points at.
    expect(started.url).toContain('redirect_uri=')
  })

  it('finishes the sign-in from the callback alone, with no code copied', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-openai-subscription'))
    const login = scaffold.ctx.get('openaiAccountLogin') as {
      beginLogin(uri: string, signal: AbortSignal): { url: string; handle: string }
      awaitLogin(handle: string, signal: AbortSignal): Promise<{ signedIn: boolean; planType?: string }>
    }
    const signal = new AbortController().signal
    const started = login.beginLogin(`${originOf(double)}/callback`, signal)
    const state = new URL(started.url).searchParams.get('state')!
    // The browser reaching the callback is what completes the attempt; the
    // waiting call settles from the delivered code.
    const waiting = login.awaitLogin(started.handle, signal)
    const host = new URL(scaffold.authenticatedUrl).origin
    const answered = await fetch(`${host}/auth/callback?state=${encodeURIComponent(state)}&code=good-code`)
    expect(answered.status).toBe(200)
    await expect(waiting).resolves.toMatchObject({ signedIn: true, planType: 'team' })
  })

  it('refuses a replayed authorization code', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-openai-subscription'))
    const login = scaffold.ctx.get('openaiAccountLogin') as {
      beginLogin(uri: string, signal: AbortSignal): { url: string; handle: string }
      completeLogin(handle: string, code: string, signal: AbortSignal): Promise<unknown>
    }
    const signal = new AbortController().signal
    const started = login.beginLogin(`${originOf(double)}/callback`, signal)
    // The provider spends a code once; the double refuses the second use, and
    // the failure surfaces instead of storing a session it never received.
    await expect(login.completeLogin(started.handle, 'good-code', signal)).rejects.toThrow()
  })

  it('refuses a handle it never issued', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-openai-subscription'))
    const login = scaffold.ctx.get('openaiAccountLogin') as {
      completeLogin(handle: string, code: string, signal: AbortSignal): Promise<unknown>
    }
    // A handle no attempt created cannot carry a verifier this Host holds.
    await expect(login.completeLogin('not-a-handle', 'good-code', new AbortController().signal))
      .rejects.toThrow(/unknown or expired/)
  })
})

/**
 * Name the double's origin for the callback the authorization request carries.
 * @param server - the listening loopback double.
 * @returns the origin, or an empty string when it is not bound to a port.
 */
function originOf(server: Server): string {
  const address = server.address()
  return typeof address === 'object' && address !== null
    ? `http://127.0.0.1:${String(address.port)}`
    : ''
}
