/** Real local OAuth and analytics composition, with no external services or credentials. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Authorization from '@deepseek-ai/dsh-authorization'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { VerbooAccount } from '@deepseek-ai/dsh-verboo-account/src/account.ts'
import { GrantVault } from '@deepseek-ai/dsh-verboo-account/src/vault.ts'
import type { Config as AccountConfig } from '@deepseek-ai/dsh-verboo-account/src/config.ts'
import VerbooAnalytics from '../src/index.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function fixture(initiallyGranted: boolean, includeServerTime = true) {
  const home = await mkdtemp(join(tmpdir(), 'verboo-product-oauth-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const events: Array<{ name: string; eventId: string; occurredAt: string; consentRevision: number }> = []
  const preference = { granted: initiallyGranted, denied: false, decidedAt: '2020-01-01T00:00:00Z', order: '1' }
  let serverOrder = 10n
  let releaseConsent!: () => void
  const consentGate = { enabled: false, waiting: false, release: () => { releaseConsent() } }
  const consentReady = new Promise<void>((resolve) => { releaseConsent = resolve })
  cleanup.push(async () => { releaseConsent() })
  const server = createServer((req, res) => { void (async () => {
    let body = ''
    for await (const part of req) body += String(part)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/oauth/token') {
      res.end(JSON.stringify({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600 }))
    } else if (req.url === '/api/me') {
      res.end(JSON.stringify({ data: { id: '9cc3776a-84bf-4ea8-ac35-0916d7ed57f1', name: 'Fixture', email: 'fixture@example.invalid' } }))
    } else if (req.url === '/api/analytics/product-consent') {
      if (consentGate.enabled && req.headers.authorization === 'Bearer fixture-token') {
        consentGate.waiting = true
        await consentReady
      }
      const granted = req.headers.authorization === 'Bearer fixture-token' && preference.granted
      const issued = String(++serverOrder)
      res.end(JSON.stringify({ data: { subjectId: (req.headers.authorization ? 'b' : 'a').repeat(64),
        decision: granted ? 'granted' : preference.denied && req.headers.authorization ? 'denied' : 'unknown',
        revision: granted ? 1 : preference.denied && req.headers.authorization ? 2 : 0, policyVersion: 1,
        decidedAt: preference.decidedAt, expiresAt: '2099-01-01T00:00:00Z', enabled: true, decisionOrder: granted ? preference.order : '0',
        ...(includeServerTime ? { serverTime: new Date().toISOString(), serverOrder: issued, serverProof: `v1.${issued}.${'a'.repeat(64)}` } : {}) } }))
    } else if (req.url === '/api/analytics/product-events') {
      const event = JSON.parse(body) as { name: string; eventId: string; occurredAt: string; consentRevision: number }
      events.push(event)
      res.statusCode = 202
      res.end(JSON.stringify({ data: { status: 'accepted', eventId: event.eventId,
        receipt: { eventId: event.eventId, payloadSha256: createHash('sha256').update(body).digest('hex') } } }))
    } else if (req.url === '/api/journey/events') {
      const request = JSON.parse(body) as { schemaVersion: number; events: Array<{ eventId: string; journeyId: string }> }
      res.statusCode = 202
      res.end(JSON.stringify({ data: { receipts: request.events.map((event: { eventId: string; journeyId: string }) => ({
        eventId: event.eventId, journeyId: event.journeyId, clientApp: '',
        payloadSha256: createHash('sha256').update(`${request.schemaVersion}:${JSON.stringify(event)}`).digest('hex'),
      })) } }))
    } else { res.statusCode = 404; res.end('{}') }
  })() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server missing address')
  const origin = `http://127.0.0.1:${address.port}`
  let secret: number[] | null = null
  const vault = new GrantVault(origin, home, { async getSecret() { return secret }, async setSecret(value) { secret = [...value] } })
  class FixtureAccount extends VerbooAccount {
    constructor(ctx: Context, config: AccountConfig) { super(ctx, config, vault) }
  }
  const config = join(home, 'cordis.yml')
  await writeFile(config, [
    '- name: cordis:credentials', '  config:', `    path: ${JSON.stringify(join(home, 'credentials.yml'))}`, '    watch: false',
    '- name: cordis:authorization', '- name: cordis:web', '  config:', '    host: 127.0.0.1', '    port: 0',
    '- name: cordis:account', '  config:', `    apiOrigin: ${origin}`, `    routerBaseURL: ${origin}/router/v1`,
    '    allowLoopbackHttp: true', '- name: cordis:sessions', '- name: cordis:projections',
    '- name: cordis:analytics', '  config:', `    apiOrigin: ${origin}`, `    routerBaseURL: ${origin}/router/v1`,
    '    allowLoopbackHttp: true', '    surface: desktop', '    appVersion: fixture', '    retryIntervalMs: 1000', '',
  ].join('\n'))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(config).href
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, credentials: LocalCredentialProvider, authorization: Authorization,
    web: WebServer, account: FixtureAccount, sessions: SessionStore, projections: SessionProjectionRegistry, analytics: VerbooAnalytics })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  await ctx.verbooAnalytics.status()
  const callbackOrigin = `http://127.0.0.1:${ctx.webServer.port}`
  const login = async () => {
    await ctx.deepseekAccount.startSignIn({ version: 'fixture', locale: 'pt', timezoneOffsetSeconds: 0 }, callbackOrigin, 'desktop')
    await vi.waitFor(async () => { expect((await ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser') })
    const attempt = (await ctx.deepseekAccount.getState()).attempt
    if (!attempt?.authorizeUrl) throw new Error('authorization URL missing')
    const callback = new URL('/callback', callbackOrigin)
    callback.searchParams.set('state', new URL(attempt.authorizeUrl).searchParams.get('state') ?? '')
    callback.searchParams.set('code', 'fixture-code')
    const response = await fetch(callback)
    expect(response.status).toBe(200)
    await vi.waitFor(async () => { expect((await ctx.deepseekAccount.getState()).attempt?.phase).toBe('succeeded') })
  }
  return { ctx, events, preference, login, consentGate, nextOrder: () => String(++serverOrder) }
}

it('observes a real new OAuth login when consent predates the attempt', async () => {
  const app = await fixture(true)
  await app.login()
  await vi.waitFor(() => { expect(app.events.filter(event => event.name === 'product_login_completed')).toHaveLength(1) }, { timeout: 10_000 })
  await app.ctx.verbooAnalytics.status()
  await delay(1200)
  const events = app.events.filter(event => event.name === 'product_login_completed')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ consentRevision: 1 })
  expect(JSON.stringify(events)).not.toMatch(/fixture-token|fixture-refresh|example\.invalid/)
}, 20_000)

it('does not create a login event when consent is granted only after real OAuth', async () => {
  const app = await fixture(false)
  await app.login()
  app.preference.decidedAt = new Date().toISOString()
  app.preference.granted = true
  app.preference.order = app.nextOrder()
  await app.ctx.verbooAnalytics.status()
  await vi.waitFor(() => { expect(app.events.filter(event => event.name === 'product_authenticated_observed')).toHaveLength(1) }, { timeout: 10_000 })
  await app.ctx.verbooAnalytics.status()
  await delay(1200)
  expect(app.events.filter(event => event.name === 'product_login_completed')).toHaveLength(0)
  expect(app.events.filter(event => event.name === 'product_authenticated_observed')).toHaveLength(1)
  expect(JSON.stringify(app.events)).not.toMatch(/fixture-token|fixture-refresh|example\.invalid/)
}, 20_000)

it('does not borrow a grant made during OAuth when the device clock is ahead', async () => {
  const app = await fixture(false)
  app.consentGate.enabled = true
  const realNow = Date.now.bind(Date)
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000)
  try {
    await app.login()
    await vi.waitFor(() => { expect(app.consentGate.waiting).toBe(true) }, { timeout: 5000 })
    app.preference.decidedAt = new Date().toISOString()
    app.preference.granted = true
    app.preference.order = app.nextOrder()
    app.consentGate.release()
    await app.ctx.verbooAnalytics.status()
    await delay(1500)
    expect(app.events.filter(event => event.name === 'product_login_completed')).toHaveLength(0)
  } finally { clock.mockRestore(); app.consentGate.release() }
}, 20_000)

it('does not record a login when the server does not provide a prior time reference', async () => {
  const app = await fixture(true, false)
  await app.login()
  await delay(1500)
  expect(app.events.filter(event => event.name === 'product_login_completed')).toHaveLength(0)
  expect(app.events.filter(event => event.name === 'product_authenticated_observed')).toHaveLength(0)
}, 20_000)

it('does not record a login when consent is revoked while OAuth is completing', async () => {
  const app = await fixture(true)
  app.consentGate.enabled = true
  try {
    await app.login()
    await vi.waitFor(() => { expect(app.consentGate.waiting).toBe(true) }, { timeout: 5000 })
    app.preference.granted = false
    app.preference.denied = true
    app.consentGate.release()
    await app.ctx.verbooAnalytics.status()
    await delay(1500)
    expect(app.events.filter(event => event.name === 'product_login_completed')).toHaveLength(0)
    expect(app.events.filter(event => event.name === 'product_authenticated_observed')).toHaveLength(0)
  } finally { app.consentGate.release() }
}, 20_000)

it('fails closed when the device clock is behind a recent grant', async () => {
  const app = await fixture(true)
  app.preference.decidedAt = new Date().toISOString()
  const realNow = Date.now.bind(Date)
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 60_000)
  try {
    await app.login()
    await app.ctx.verbooAnalytics.status()
    await delay(1500)
    expect(app.events.filter(event => event.name === 'product_login_completed')).toHaveLength(0)
  } finally { clock.mockRestore() }
}, 20_000)
