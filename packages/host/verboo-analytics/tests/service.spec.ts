/** Real Loader, local credentials and HTTP collector: no product content crosses the wire. */
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProductAnalyticsSubject } from '../src/types.ts'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountSessionId, AccountUserId, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type {} from '@deepseek-ai/dsh-verboo-account'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import VerbooAnalytics from '../src/index.ts'
import { AnalyticsStorageStore, eventSchema } from '../src/storage.ts'

function createAnalyticsServer(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error('analytics fixture request failed'))
    })
  })
}

class AnonymousAccount extends DeepSeekAccount {
  getState = vi.fn<DeepSeekAccount['getState']>()
  getProfile = vi.fn<DeepSeekAccount['getProfile']>()
  getBalance = vi.fn<DeepSeekAccount['getBalance']>()
  getUnnotifiedBonuses = vi.fn<DeepSeekAccount['getUnnotifiedBonuses']>()
  ackBonusNotified = vi.fn<DeepSeekAccount['ackBonusNotified']>()
  startSignIn = vi.fn<DeepSeekAccount['startSignIn']>()
  cancelSignIn = vi.fn<DeepSeekAccount['cancelSignIn']>()
  signOut = vi.fn<DeepSeekAccount['signOut']>()
  watch = vi.fn<DeepSeekAccount['watch']>()
  resolveToken = vi.fn<DeepSeekAccount['resolveToken']>().mockResolvedValue(undefined)
  rejectToken = vi.fn<DeepSeekAccount['rejectToken']>()
  getPlatformSession = vi.fn<DeepSeekAccount['getPlatformSession']>().mockResolvedValue(null)
  getDeviceIdentity = vi.fn<DeepSeekAccount['getDeviceIdentity']>()
}
const cleanup: Array<() => Promise<unknown>> = []
const proof = (order: string) => `v1.${order}.${'a'.repeat(64)}`
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

it('requires consent and sends only a completed root response through the real service', async () => {
  const home = await mkdtemp(join(tmpdir(), 'verboo-product-analytics-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const events: Record<string, unknown>[] = []
  let rejectEvents = false
  let includeServerProof = true
  let serverNow = Date.now()
  let serverOrder = 9007199254740992n // Above Number.MAX_SAFE_INTEGER.
  let consent = { subjectId: 'a'.repeat(64), decision: 'unknown', revision: 0, policyVersion: 1,
    decidedAt: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', enabled: true, decisionOrder: '0' }
  const server = createAnalyticsServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += String(part)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/analytics/product-consent') {
      if (req.method === 'PUT') {
        const decision = z.object({ decision: z.enum(['granted', 'denied']) }).parse(JSON.parse(body)).decision
        consent = { ...consent, decision, revision: consent.revision + 1, decisionOrder: String(++serverOrder) }
      }
      const issued = String(++serverOrder)
      res.end(JSON.stringify({ data: { ...consent, serverTime: new Date(serverNow).toISOString(), serverOrder: issued,
        ...(includeServerProof ? { serverProof: proof(issued) } : {}) } }))
      return
    }
    if (req.url === '/api/analytics/product-events') {
      const event = eventSchema.parse(JSON.parse(body))
      events.push(event)
      if (rejectEvents) { res.statusCode = 503; res.end('{}'); return }
      res.statusCode = 202
      res.end(JSON.stringify({ data: { status: 'accepted', eventId: event.eventId,
        receipt: { eventId: event.eventId, payloadSha256: createHash('sha256').update(body).digest('hex') } } }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server missing address')
  const origin = `http://127.0.0.1:${address.port}`
  const config = join(home, 'cordis.yml')
  await writeFile(config, [
    '- name: cordis:credentials', '  config:', `    path: ${JSON.stringify(join(home, 'credentials.yml'))}`, '    watch: false',
    '- name: cordis:account', '- name: cordis:sessions', '- name: cordis:projections',
    '- name: cordis:analytics', '  config:', `    apiOrigin: ${origin}`, `    routerBaseURL: ${origin}/router/v1`,
    '    allowLoopbackHttp: true', '    surface: desktop', '    appVersion: fixture', '    retryIntervalMs: 1000', '',
  ].join('\n'))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(config).href
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, credentials: LocalCredentialProvider, account: AnonymousAccount,
    sessions: SessionStore, projections: SessionProjectionRegistry, analytics: VerbooAnalytics })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect((await ctx.verbooAnalytics.status()).consent?.decision).toBe('unknown')
  expect(events).toEqual([])
  expect((await ctx.verbooAnalytics.choose('granted')).ok).toBe(true)
  const session = ctx.sessions.create(SessionId('fixture-root'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createMessage({ role: 'user', content: [{ type: 'text', text: 'SECRET PROMPT' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'fixture' as never, content: [], isError: false }) }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'SECRET RESPONSE' }], source: { kind: 'model', provider: 'deepseek-account', model: 'SECRET MODEL' } }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let attempt = 0; attempt < 100 && !events.some(event => event.name === 'product_response_completed'); attempt++) await delay(50)
  const response = events.filter(event => event.name === 'product_response_completed')
  expect(response).toHaveLength(1)
  await vi.waitFor(() => { expect(events.filter(event => event.name === 'product_feature_used' && event.feature === 'tool')).toHaveLength(1) })
  expect(response[0]).toMatchObject({ surface: 'desktop', appVersion: 'fixture', modality: 'verboo_gateway', outcome: 'completed', consentRevision: 1 })
  expect(JSON.stringify(events)).not.toMatch(/SECRET|fixture-root/)
  const oldProof = (await ctx.verbooAnalytics.status()).consent?.referenceProof ?? ''
  ctx.verbooAnalytics.feature('browser', 'completed', brandString<ProductAnalyticsSubject>('b'.repeat(64)), consent.revision, oldProof)
  await delay(1200)
  expect(events.some(event => event.name === 'product_feature_used' && event.feature === 'browser')).toBe(false)
  rejectEvents = true
  const oldRevision = consent.revision
  ctx.verbooAnalytics.feature('browser', 'completed', brandString<ProductAnalyticsSubject>(consent.subjectId), oldRevision, oldProof)
  for (let attempt = 0; attempt < 100 && !events.some(event => event.name === 'product_feature_used' && event.feature === 'browser'); attempt++) await delay(50)
  const failed = events.find(event => event.name === 'product_feature_used' && event.feature === 'browser')
  expect(failed).toBeDefined()
  expect((await ctx.verbooAnalytics.choose('denied')).ok).toBe(true)
  rejectEvents = false
  expect((await ctx.verbooAnalytics.choose('granted')).ok).toBe(true)
  const newProof = (await ctx.verbooAnalytics.status()).consent?.referenceProof ?? ''
  // An action begun under the old grant, or before any grant, cannot borrow
  // the new revision just because it finished after the user re-enabled it.
  ctx.verbooAnalytics.feature('browser', 'completed', brandString<ProductAnalyticsSubject>(consent.subjectId), oldRevision, oldProof)
  ctx.verbooAnalytics.feature('browser', 'completed', brandString<ProductAnalyticsSubject>(consent.subjectId), 0, newProof)
  await delay(1500)
  expect(events.filter(event => event.eventId === failed?.eventId)).toHaveLength(1)
  expect(events.filter(event => event.name === 'product_feature_used' && event.feature === 'browser')).toHaveLength(1)
  ctx.verbooAnalytics.feature('browser', 'completed', brandString<ProductAnalyticsSubject>(consent.subjectId), consent.revision, newProof)
  for (let attempt = 0; attempt < 100 && events.filter(event => event.name === 'product_feature_used' && event.feature === 'browser').length < 2; attempt++) await delay(50)
  expect(events.filter(event => event.name === 'product_feature_used' && event.feature === 'browser')).toHaveLength(2)

  // The account can grant consent elsewhere while the Host is still reading
  // the owner for a turn that began with no grant. The local device is ahead.
  consent = { ...consent, decision: 'unknown', revision: consent.revision + 1 }
  serverNow = Date.now()
  await ctx.verbooAnalytics.status()
  const beforeResponses = events.filter(event => event.name === 'product_response_completed').length
  const beforeTools = events.filter(event => event.name === 'product_feature_used' && event.feature === 'tool').length
  const account = ctx.deepseekAccount as AnonymousAccount
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let captured = false
  account.getPlatformSession.mockImplementationOnce(async () => {
    captured = true
    await barrier
    return null
  })
  const realNow = Date.now.bind(Date)
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000)
  try {
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createMessage({ role: 'user', content: [{ type: 'text', text: 'PRIVATE' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId: 'fixture' as never, content: [], isError: false }) }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 2, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'PRIVATE' }], source: { kind: 'model', provider: 'deepseek-account', model: 'fixture' } }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(captured).toBe(true) })
    consent = { ...consent, decision: 'granted', revision: consent.revision + 1, decidedAt: new Date(serverNow - 60_000).toISOString(), decisionOrder: String(++serverOrder) }
    serverNow += 2000
    await ctx.verbooAnalytics.status()
    release()
    await delay(1500)
    expect(events.filter(event => event.name === 'product_response_completed')).toHaveLength(beforeResponses)
    expect(events.filter(event => event.name === 'product_feature_used' && event.feature === 'tool')).toHaveLength(beforeTools)
  } finally { release(); clock.mockRestore(); account.getPlatformSession.mockResolvedValue(null) }

  // A compatible older server can still serve privacy settings, but it cannot
  // authorize a turn without a reference received before that turn started.
  includeServerProof = false
  consent = { ...consent, decidedAt: '2020-01-01T00:00:00Z' }
  await ctx.verbooAnalytics.status()
  session.append('turn/start', { turn: 3 })
  session.append('user/message', createMessage({ role: 'user', content: [{ type: 'text', text: 'PRIVATE' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 3, step: 1 })
  session.append('tool/result', { turn: 3, step: 1, message: createToolResultMessage({ callId: 'fixture' as never, content: [], isError: false }) }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 3, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'PRIVATE' }], source: { kind: 'model', provider: 'deepseek-account', model: 'fixture' } }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  await delay(1200)
  expect(events.filter(event => event.name === 'product_response_completed')).toHaveLength(beforeResponses)
  expect(events.filter(event => event.name === 'product_feature_used' && event.feature === 'tool')).toHaveLength(beforeTools)

  // A later server synchronization before user/message cannot replace the
  // reference already frozen at turn/start.
  includeServerProof = true
  consent = { ...consent, decision: 'unknown', revision: consent.revision + 1 }
  serverNow = Date.now()
  await ctx.verbooAnalytics.status()
  const nextClock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000)
  try {
    session.append('turn/start', { turn: 4 })
    consent = { ...consent, decision: 'granted', revision: consent.revision + 1, decidedAt: new Date(serverNow - 60_000).toISOString(), decisionOrder: String(++serverOrder) }
    serverNow += 2000
    await ctx.verbooAnalytics.status()
    session.append('user/message', createMessage({ role: 'user', content: [{ type: 'text', text: 'PRIVATE' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 4, step: 1 })
    session.append('tool/result', { turn: 4, step: 1, message: createToolResultMessage({ callId: 'fixture' as never, content: [], isError: false }) }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 4, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'PRIVATE' }], source: { kind: 'model', provider: 'deepseek-account', model: 'fixture' } }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    await delay(1500)
    expect(events.filter(event => event.name === 'product_response_completed')).toHaveLength(beforeResponses)
    expect(events.filter(event => event.name === 'product_feature_used' && event.feature === 'tool')).toHaveLength(beforeTools)
  } finally { nextClock.mockRestore() }

  const store = new AnalyticsStorageStore(ctx.credentials)
  const beforeLost = (await store.read()).lost
  const legacyId = randomUUID()
  await store.update((state) => {
    const identity = state.contexts.find(item => item.owner === state.activeOwner)
    if (!identity) throw new Error('fixture identity missing')
    identity.firstOpenEventId = legacyId
    state.pending.push({ eventId: legacyId, owner: identity.owner, attempts: 0, nextAttemptAt: 0,
      json: JSON.stringify({ schemaVersion: 1, eventId: legacyId, name: 'product_first_open_observed',
        consentRevision: consent.revision, occurredAt: new Date().toISOString(), surface: 'desktop', os: 'linux', appVersion: 'fixture' }) })
  })
  await ctx.verbooAnalytics.status()
  const cleaned = await store.read()
  expect(cleaned.pending.some(item => item.eventId === legacyId)).toBe(false)
  expect(cleaned.contexts.find(item => item.owner === cleaned.activeOwner)?.firstOpenEventId).toBeNull()
  expect(cleaned.lost).toBe(beforeLost + 1)
  expect(events.some(event => event.eventId === legacyId)).toBe(false)
}, 25_000)

it('does not attribute delayed opening or login observations to a replacement account', async () => {
  const home = await mkdtemp(join(tmpdir(), 'verboo-product-analytics-account-race-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const events: Array<{ eventId: string; name: string; authorization: string | undefined }> = []
  let serverOrder = 10n
  let holdAccountAConsent = false
  let accountAConsentStarted = false
  let releaseAccountAConsent!: () => void
  const accountAConsentGate = new Promise<void>((resolve) => { releaseAccountAConsent = resolve })
  const server = createAnalyticsServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += String(part)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/analytics/product-consent') {
      const authenticated = req.headers.authorization !== undefined
      if (req.headers.authorization === 'Bearer token-a' && holdAccountAConsent) {
        accountAConsentStarted = true
        await accountAConsentGate
      }
      const issued = String(++serverOrder)
      res.end(JSON.stringify({ data: { subjectId: (req.headers.authorization === 'Bearer token-b' ? 'b' : 'a').repeat(64),
        decision: authenticated ? 'granted' : 'unknown', revision: authenticated ? 1 : 0,
        policyVersion: 1, decidedAt: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', enabled: true,
        serverTime: new Date().toISOString(), decisionOrder: authenticated ? '1' : '0', serverOrder: issued, serverProof: proof(issued) } }))
      return
    }
    if (req.url === '/api/analytics/product-events') {
      const event = eventSchema.parse(JSON.parse(body))
      events.push({ ...event, authorization: req.headers.authorization })
      res.statusCode = 202
      res.end(JSON.stringify({ data: { status: 'accepted', eventId: event.eventId,
        receipt: { eventId: event.eventId, payloadSha256: createHash('sha256').update(body).digest('hex') } } }))
      return
    }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server missing address')
  const origin = `http://127.0.0.1:${address.port}`
  const config = join(home, 'cordis.yml')
  await writeFile(config, [
    '- name: cordis:credentials', '  config:', `    path: ${JSON.stringify(join(home, 'credentials.yml'))}`, '    watch: false',
    '- name: cordis:account', '- name: cordis:sessions', '- name: cordis:projections',
    '- name: cordis:analytics', '  config:', `    apiOrigin: ${origin}`, `    routerBaseURL: ${origin}/router/v1`,
    '    allowLoopbackHttp: true', '    surface: desktop', '    appVersion: fixture', '    retryIntervalMs: 1000', '',
  ].join('\n'))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(config).href
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, credentials: LocalCredentialProvider, account: AnonymousAccount,
    sessions: SessionStore, projections: SessionProjectionRegistry, analytics: VerbooAnalytics })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  await ctx.verbooAnalytics.status() // Settle the initial anonymous synchronization.
  const account = ctx.deepseekAccount as AnonymousAccount
  const session = (user: string) => ({ origin, token: `token-${user}`,
    userId: brandString<AccountUserId>(`user-${user}`), sessionId: brandString<AccountSessionId>(`session-${user}`) })
  account.getPlatformSession.mockResolvedValue(session('a'))
  account.resolveToken.mockResolvedValue('token-a')
  ctx.emit('credentials/record-updated', credentialKey('verboo-account', 'default'))
  holdAccountAConsent = true
  const delayedAccountAStatus = ctx.verbooAnalytics.status()
  await vi.waitFor(() => { expect(accountAConsentStarted).toBe(true) })
  account.getPlatformSession.mockResolvedValue(session('b'))
  account.resolveToken.mockResolvedValue('token-b')
  ctx.emit('credentials/record-updated', credentialKey('verboo-account', 'default'))
  const coalescedAccountBStatus = ctx.verbooAnalytics.status()
  holdAccountAConsent = false
  releaseAccountAConsent()
  await Promise.all([delayedAccountAStatus, coalescedAccountBStatus])
  await ctx.verbooAnalytics.status() // The delayed A refresh had been coalesced with B's first status call.
  await vi.waitFor(() => {
    expect(events.filter(event => event.authorization === 'Bearer token-b' && event.name === 'product_opened')).toHaveLength(1)
  }, { timeout: 5000 })
  expect(events.some(event => event.authorization === 'Bearer token-a')).toBe(false)

  // A login observation blocked in an account-owned dependency cannot be
  // attributed to whichever account replaces it before the profile completes.
  let releaseProfile!: () => void
  let accountAProfileStarted = false
  const accountAProfileGate = new Promise<void>((resolve) => { releaseProfile = resolve })
  account.getPlatformSession.mockResolvedValue(session('a'))
  account.resolveToken.mockResolvedValue('token-a')
  ctx.emit('credentials/record-updated', credentialKey('verboo-account', 'default'))
  account.getProfile.mockImplementationOnce(async () => {
    accountAProfileStarted = true
    await accountAProfileGate
    return null
  })
  const startedA = Date.now()
  const attemptA = brandString<SignInAttemptId>('attempt-a')
  ctx.emit('verboo-account/login-started', attemptA)
  ctx.emit('verboo-account/login-completed', brandString<AccountSessionId>('session-a'), attemptA, startedA, Date.now())
  await vi.waitFor(() => { expect(accountAProfileStarted).toBe(true) })
  account.getPlatformSession.mockResolvedValue(session('b'))
  account.resolveToken.mockResolvedValue('token-b')
  ctx.emit('credentials/record-updated', credentialKey('verboo-account', 'default'))
  await ctx.verbooAnalytics.status()
  const startedB = Date.now()
  const attemptB = brandString<SignInAttemptId>('attempt-b')
  ctx.emit('verboo-account/login-started', attemptB)
  ctx.emit('verboo-account/login-completed', brandString<AccountSessionId>('session-b'), attemptB, startedB, Date.now())
  releaseProfile()
  await vi.waitFor(() => {
    expect(events.filter(event => event.authorization === 'Bearer token-b' && event.name === 'product_login_completed')).toHaveLength(1)
  }, { timeout: 5000 })
  await delay(1200)
  const bEvents = events.filter(event => event.authorization === 'Bearer token-b')
  expect(bEvents.filter(event => event.name === 'product_opened')).toHaveLength(1)
  expect(bEvents.filter(event => event.name === 'product_login_completed')).toHaveLength(1)
  expect(events.some(event => event.authorization === 'Bearer token-a')).toBe(false)
}, 15_000)

it('deduplicates the first observed opening across simultaneous Hosts sharing credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'verboo-product-analytics-concurrent-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const events: Array<{ eventId: string; name: string }> = []
  let release!: () => void
  const bothReading = new Promise<void>((resolve) => { release = resolve })
  let reads = 0
  const server = createAnalyticsServer(async (req, res) => {
    let body = ''
    for await (const part of req) body += String(part)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/analytics/product-consent') {
      if (++reads === 2) release()
      if (reads <= 2) await bothReading
      res.end(JSON.stringify({ data: { subjectId: 'a'.repeat(64), decision: 'granted', revision: 1,
        policyVersion: 1, decidedAt: '2020-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', enabled: true,
        decisionOrder: '1', serverOrder: '2', serverTime: new Date().toISOString(), serverProof: proof('2') } }))
      return
    }
    if (req.url === '/api/analytics/product-events') {
      const event = eventSchema.parse(JSON.parse(body))
      events.push(event)
      res.statusCode = 202
      res.end(JSON.stringify({ data: { status: 'accepted', eventId: event.eventId,
        receipt: { eventId: event.eventId, payloadSha256: createHash('sha256').update(body).digest('hex') } } }))
      return
    }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server missing address')
  const origin = `http://127.0.0.1:${address.port}`
  const config = join(home, 'cordis.yml')
  await writeFile(config, [
    '- name: cordis:credentials', '  config:', `    path: ${JSON.stringify(join(home, 'credentials.yml'))}`, '    watch: false',
    '- name: cordis:account', '- name: cordis:sessions', '- name: cordis:projections',
    '- name: cordis:analytics', '  config:', `    apiOrigin: ${origin}`, `    routerBaseURL: ${origin}/router/v1`,
    '    allowLoopbackHttp: true', '    surface: desktop', '    appVersion: fixture', '    retryIntervalMs: 1000', '',
  ].join('\n'))
  async function boot() {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    ctx.baseUrl = pathToFileURL(config).href
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, credentials: LocalCredentialProvider, account: AnonymousAccount,
      sessions: SessionStore, projections: SessionProjectionRegistry, analytics: VerbooAnalytics })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    return ctx
  }
  await Promise.all([boot(), boot()])
  for (let attempt = 0; attempt < 100 && !events.some(event => event.name === 'product_first_open_observed'); attempt++) await delay(50)
  await delay(1200)
  const firstOpenIds = new Set(events.filter(event => event.name === 'product_first_open_observed').map(event => event.eventId))
  expect(firstOpenIds.size).toBe(1)
})
