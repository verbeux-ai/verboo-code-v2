import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountSessionId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ConnectionId, PlanId } from '../src/types.ts'
import { VerbooProduct } from '../src/index.ts'

vi.mock('ws', () => ({ default: function mockSocket(url: string, options: unknown) {
  const Socket = globalThis.WebSocket as unknown as new (url: string, options: unknown) => object
  return new Socket(url, options)
} }))

class FixtureAccount extends DeepSeekAccount {
  getState = vi.fn<DeepSeekAccount['getState']>()
  getProfile = vi.fn<DeepSeekAccount['getProfile']>()
  getBalance = vi.fn<DeepSeekAccount['getBalance']>()
  getUnnotifiedBonuses = vi.fn<DeepSeekAccount['getUnnotifiedBonuses']>()
  ackBonusNotified = vi.fn<DeepSeekAccount['ackBonusNotified']>()
  startSignIn = vi.fn<DeepSeekAccount['startSignIn']>()
  cancelSignIn = vi.fn<DeepSeekAccount['cancelSignIn']>()
  signOut = vi.fn<DeepSeekAccount['signOut']>()
  watch = vi.fn<DeepSeekAccount['watch']>()
  resolveToken = vi.fn<DeepSeekAccount['resolveToken']>()
  rejectToken = vi.fn<DeepSeekAccount['rejectToken']>()
  getPlatformSession = vi.fn<DeepSeekAccount['getPlatformSession']>()
  getDeviceIdentity = vi.fn<DeepSeekAccount['getDeviceIdentity']>()
}

const session = (id: string): PlatformSession => ({
  origin: 'https://code.verboo.ai', token: 'fixture-token', userId: null,
  sessionId: id as AccountSessionId,
})

const contexts: Context[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  while (contexts.length) await contexts.pop()!.fiber.dispose()
})

/**
 * Serve a scripted sequence of responses to the product service.
 * @param responses - one entry per request, in call order.
 * @returns the service, the recorded fetch, and a request signal.
 */
function fixture(...responses: Response[]) {
  return configured({}, ...responses)
}

/**
 * Serve a scripted sequence under an explicit deployment configuration.
 * @param config - product configuration, including request ceilings.
 * @param responses - one entry per request, in call order.
 * @returns the service, the recorded fetch, and a request signal.
 */
function configured(config: Record<string, unknown>, ...responses: Response[]) {
  const ctx = new Context()
  contexts.push(ctx)
  const account = new FixtureAccount(ctx)
  account.getPlatformSession.mockResolvedValue(session('account-a'))
  account.resolveToken.mockResolvedValue('fixture-token')
  const queue = [...responses]
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('unexpected request')
    return next
  })
  vi.stubGlobal('fetch', fetch)
  const product = new VerbooProduct(ctx, config)
  return { product, fetch, account, signal: new AbortController().signal }
}

/** Answer one request only after a delay, honoring the caller's cancellation. */
const delayed = (delayMs: number, body: Response): typeof globalThis.fetch =>
  async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }, { once: true })
    })
    return body
  }

/** Send headers now and finish the JSON body later, as a slow catalog may do. */
const delayedBody = (delayMs: number, body: unknown): typeof globalThis.fetch =>
  async (_input: RequestInfo | URL, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setTimeout(() => {
          init?.signal?.removeEventListener('abort', abort)
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)))
          controller.close()
        }, delayMs)
        const abort = () => {
          clearTimeout(timer)
          controller.error(new Error('aborted'))
        }
        init?.signal?.addEventListener('abort', abort, { once: true })
      },
    })
    return new Response(stream, { headers: { 'content-type': 'application/json' } })
  }

const link = (url: string, id: string | null = null): Response => Response.json({
  data: { url, expiresAt: '2026-11-05T12:00:00Z', id },
})

const plan = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Pro', description: 'Pro',
  priceCents: 1000, currency: 'BRL', billingInterval: 'month',
}

describe('live account generation speed', () => {
  it('subscribes with a private ticket and streams safe measurements', async () => {
    let socket: FakeSocket | undefined
    const register = (value: FakeSocket) => { socket = value }
    class FakeSocket extends EventTarget {
      sent: string[] = []
      closed = false
      constructor(readonly url: string, readonly options: { origin: string }) { super(); register(this) }
      send(value: string) { this.sent.push(value) }
      close() { this.closed = true; this.dispatchEvent(new Event('close')) }
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    const f = fixture(Response.json({ data: { ticket: 'private-ticket', expiresAt: '2026-11-26T12:01:00Z' } }))
    const abort = new AbortController()
    const iterator = f.product.watchUsageSpeed(abort.signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    await vi.waitFor(() => expect(socket).toBeDefined())
    expect(socket!.url).toBe('wss://code.verboo.ai/ws/me/usage')
    expect(socket!.options.origin).toBe('https://code.verboo.ai')
    socket!.dispatchEvent(new Event('open'))
    expect(JSON.parse(socket!.sent[0]!)).toEqual({ type: 'subscribe', ticket: 'private-ticket', billingMode: 'subscription' })
    socket!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'snapshot', generatedAt: '2026-11-26T12:00:00Z', points: [], generationRateContract: 2, generationTokensPerSecond: 90, generationRateQuality: 'measured', concurrent: 3 }) }))
    expect((await next).value).toEqual({ at: '2026-11-26T12:00:00Z', stale: false, measurement: { value: 90, quality: 'measured', partial: false, at: '2026-11-26T12:00:00Z', previous: false } })
    abort.abort()
    await iterator.return?.()
    expect(socket!.closed).toBe(true)
  })
  it('never publishes a frame after switching accounts', async () => {
    let socket: FakeSocket | undefined
    const register = (value: FakeSocket) => { socket = value }
    class FakeSocket extends EventTarget {
      constructor(_url: string) { super(); register(this) }
      send(_value: string) {}
      close() { this.dispatchEvent(new Event('close')) }
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    const f = fixture(Response.json({ data: { ticket: 'private-ticket' } }))
    const iterator = f.product.watchUsageSpeed(new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    await vi.waitFor(() => expect(socket).toBeDefined())
    socket!.dispatchEvent(new Event('open'))
    f.account.getPlatformSession.mockResolvedValue(session('account-b'))
    socket!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'snapshot', generatedAt: '2026-11-26T12:00:00Z', points: [], generationTokensPerSecond: 90, generationRateQuality: 'measured' }) }))
    expect((await next).done).toBe(true)
  })
})

describe('connection authorization handoff', () => {
  it('returns a trusted Composio link and names the created account', async () => {
    const f = fixture(link('https://connect.composio.dev/session/abc', 'ca_new'))
    expect(await f.product.connect('googledrive', 'Work')).toEqual({
      ok: true,
      data: {
        url: 'https://connect.composio.dev/session/abc',
        expiresAt: '2026-11-05T12:00:00Z',
        id: 'ca_new' as ConnectionId,
      },
    })
    const [url, request] = f.fetch.mock.calls[0]!
    expect(url).toBe('https://code.verboo.ai/api/me/connections/link')
    expect(request!.method).toBe('POST')
    expect(JSON.parse(request!.body as string)).toEqual({ toolkit: 'googledrive', label: 'Work' })
  })

  it.each([
    ['a non-Composio host', 'https://evil.example.com/session/abc'],
    ['plain http', 'http://connect.composio.dev/session/abc'],
    ['embedded credentials', 'https://user:pass@connect.composio.dev/abc'],
  ])('refuses %s instead of handing the browser elsewhere', async (_label, url) => {
    const f = fixture(link(url))
    expect(await f.product.connect('googledrive', 'Work')).toEqual({ ok: false, code: 'request_failed' })
  })

  it.each([
    ['an unsupported toolkit', 'Google Drive', 'Work'],
    ['a blank label', 'googledrive', '   '],
  ])('rejects %s before any request', async (_label, toolkit, name) => {
    const f = fixture()
    expect(await f.product.connect(toolkit, name)).toEqual({ ok: false, code: 'contract_error' })
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('disconnects only the encoded account identity', async () => {
    const f = fixture(Response.json({ data: null }))
    expect(await f.product.disconnect('ca_work' as ConnectionId)).toEqual({ ok: true, data: null })
    const [url, request] = f.fetch.mock.calls[0]!
    expect(url).toBe('https://code.verboo.ai/api/me/connections/ca_work')
    expect(request!.method).toBe('DELETE')
  })

  it('rejects an account identity that is not an opaque token', async () => {
    const f = fixture()
    expect(await f.product.disconnect('../../etc/passwd' as ConnectionId)).toEqual({ ok: false, code: 'contract_error' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
})

describe('checkout handoff', () => {
  it('opens the plan list without a plan', async () => {
    const f = fixture()
    expect(await f.product.billingURL(null, false)).toEqual({
      ok: true,
      data: 'https://code.verboo.ai/pt/plans',
    })
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('subscribes to a catalog plan', async () => {
    const f = fixture(
      Response.json({ data: [] }),
      Response.json({ data: [plan] }),
    )
    expect(await f.product.billingURL(plan.id as PlanId, true)).toEqual({
      ok: true,
      data: `https://code.verboo.ai/pt/plans?plan=${plan.id}&action=subscribe`,
    })
  })

  it('renews an owned subscription', async () => {
    const owned = {
      id: '00000000-0000-4000-8000-000000000002', groupId: plan.id, group: null,
      status: 'active', currentPeriodEnd: null, cancelAtPeriodEnd: false,
      management: { changePlan: true }, billing: null,
    }
    const f = fixture(
      Response.json({ data: [owned] }),
      Response.json({ data: [] }),
    )
    expect(await f.product.billingURL(plan.id as PlanId, false)).toEqual({
      ok: true,
      data: `https://code.verboo.ai/pt/plans?plan=${plan.id}`,
    })
  })

  it('refuses a plan the account can neither buy nor renew', async () => {
    const f = fixture(
      Response.json({ data: [] }),
      Response.json({ data: [] }),
    )
    expect(await f.product.billingURL(plan.id as PlanId, true)).toEqual({ ok: false, code: 'request_failed' })
  })

  it('stops when the plan read itself failed', async () => {
    const f = fixture(
      Response.json({ error: 'unavailable' }, { status: 503 }),
    )
    expect(await f.product.billingURL(plan.id as PlanId, false)).toEqual({ ok: false, code: 'request_failed' })
  })
})

describe('agent tool discovery and execution', () => {
  const tool = {
    slug: 'GDRIVE_LIST', name: 'List files', description: 'Lists files',
    version: '20251105_01', parameters: { type: 'object' },
  }

  it('returns the discovered tools as JSON text', async () => {
    const f = fixture(Response.json({ data: [tool] }))
    expect(JSON.parse(await f.product.searchAgentConnections('ca_work', 'list files', f.signal))).toEqual([tool])
    expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({
      connectionId: 'ca_work', query: 'list files',
    })
  })

  it('allows the full backend semantic search and cleanup budget by default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    try {
      const f = fixture(Response.json({ data: [tool] }))
      await f.product.searchAgentConnections('ca_work', 'list files', f.signal)
      expect(timeout).toHaveBeenCalledWith(120_000)
    } finally {
      timeout.mockRestore()
    }
  })

  it('waits past the general per-attempt ceiling for a slow provider search', async () => {
    // Semantic search over a toolkit catalog answers far slower than the
    // account client's default 10-second attempt ceiling, and a search that
    // spent its budget cannot be retried by its caller.
    const f = configured(
      { requestTimeoutMs: 40, connectionSearchTimeoutMs: 2000 },
      Response.json({ data: [tool] }),
    )
    vi.stubGlobal('fetch', delayed(120, Response.json({ data: [tool] })))
    expect(JSON.parse(await f.product.searchAgentConnections('ca_work', 'list files', f.signal)))
      .toEqual([tool])
  })

  it('waits beyond the general ceiling for both connection catalog consumers', async () => {
    const f = configured({ requestTimeoutMs: 40, connectionListTimeoutMs: 2000 })
    const listing = { data: { available: true, toolkits: [], accounts: [] } }
    vi.stubGlobal('fetch', delayedBody(120, listing))
    expect(JSON.parse(await f.product.listAgentConnections(f.signal))).toEqual({
      available: true, accounts: [], publicServices: [],
    })
    expect(await f.product.getConnections()).toEqual({ ok: true, data: listing.data })
  })

  it('classifies an interrupted catalog body as a timeout rather than malformed JSON', async () => {
    const f = configured({ connectionListTimeoutMs: 40 })
    vi.stubGlobal('fetch', delayedBody(120, { data: { available: true, toolkits: [], accounts: [] } }))
    await expect(f.product.listAgentConnections(f.signal)).rejects.toMatchObject({ code: 'request_timeout' })
  })

  it('still stops an unrelated request at the general per-attempt ceiling', async () => {
    const f = configured({ requestTimeoutMs: 40, connectionSearchTimeoutMs: 2000 })
    vi.stubGlobal('fetch', delayed(120, Response.json({ data: [] })))
    expect(await f.product.getPlans()).toEqual({ ok: false, code: 'request_failed' })
  })

  it.each([
    ['an empty query', 'ca_work', ''],
    ['an oversized query', 'ca_work', 'a'.repeat(201)],
    ['an invalid account', '../../x', 'list files'],
  ])('rejects %s without a request', async (_label, id, query) => {
    const f = fixture()
    await expect(f.product.searchAgentConnections(id, query, f.signal)).rejects.toThrow()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('returns the provider result text unchanged, keeping wide integers', async () => {
    const text = '{"total":9007199254740993}'
    const f = fixture(Response.json({ data: { successful: true, result: text } }))
    expect(await f.product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GDRIVE_LIST', version: '20251105_01', arguments: {},
    }, f.signal)).toBe(text)
  })

  it('allows a slow execution to exceed the general request ceiling without retrying it', async () => {
    const f = configured({ requestTimeoutMs: 40, connectionExecutionTimeoutMs: 2000 })
    const fetch = vi.fn(delayed(120, Response.json({ data: { successful: true, result: '{"sent":true}' } })))
    vi.stubGlobal('fetch', fetch)
    expect(await f.product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GMAIL_SEND_EMAIL', version: '20251105_01', arguments: {},
    }, f.signal)).toBe('{"sent":true}')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reports an execution timeout as unconfirmed and does not retry', async () => {
    const f = configured({ connectionExecutionTimeoutMs: 40 })
    const fetch = vi.fn(delayed(120, Response.json({ data: { successful: true, result: '{}' } })))
    vi.stubGlobal('fetch', fetch)
    await expect(f.product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GMAIL_SEND_EMAIL', version: '20251105_01', arguments: {},
    }, f.signal)).rejects.toMatchObject({ code: 'execution_unconfirmed' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reports a provider refusal as a failed action', async () => {
    const f = fixture(Response.json({ data: { successful: false, result: 'denied' } }))
    await expect(f.product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GDRIVE_LIST', version: '20251105_01', arguments: {},
    }, f.signal)).rejects.toMatchObject({ code: 'action_failed' })
  })

  it.each([
    ['connection_action_permission_denied', 'action_permission_denied'],
    ['connection_action_not_found', 'action_not_found'],
    ['connection_action_invalid_arguments', 'action_invalid_arguments'],
    ['connection_action_rate_limited', 'action_rate_limited'],
  ])('reports the bounded provider category %s without exposing its body', async (providerCode, expectedCode) => {
    const f = fixture(Response.json({ data: { successful: false, result: JSON.stringify({ code: providerCode, detail: 'provider secret' }) } }))
    const request = f.product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GDRIVE_LIST', version: '20251105_01', arguments: {},
    }, f.signal)
    await expect(request).rejects.toMatchObject({ code: expectedCode })
    await expect(request).rejects.not.toThrow('provider secret')
  })

  it('does not expose or accept an unknown provider error category', async () => {
    const f = fixture(Response.json({ data: { successful: false, result: JSON.stringify({ code: 'private-provider-secret' }) } }))
    const request = f.product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GDRIVE_LIST', version: '20251105_01', arguments: {},
    }, f.signal)
    await expect(request).rejects.toMatchObject({ code: 'action_failed' })
    await expect(request).rejects.not.toThrow('private-provider-secret')
  })

  it.each([400, 401, 403, 404, 422])('reports HTTP %s as a refused action', async (status) => {
    const f = fixture(Response.json({ error: 'refused' }, { status }))
    await expect(f.product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GDRIVE_LIST', version: '20251105_01', arguments: {},
    }, f.signal)).rejects.toMatchObject({ code: 'action_refused' })
  })

  it.each([500, 503])('reports HTTP %s as an unconfirmed execution', async (status) => {
    const f = fixture(Response.json({ error: 'unavailable' }, { status }))
    await expect(f.product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GDRIVE_LIST', version: '20251105_01', arguments: {},
    }, f.signal)).rejects.toMatchObject({ code: 'execution_unconfirmed' })
  })

  it('reports a malformed provider response as an unconfirmed execution', async () => {
    const f = fixture(Response.json({ data: { successful: 'yes' } }))
    await expect(f.product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GDRIVE_LIST', version: '20251105_01', arguments: {},
    }, f.signal)).rejects.toMatchObject({ code: 'execution_unconfirmed' })
  })
})

describe('authentication failure reporting', () => {
  it('reports an unresolvable token as signed out', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const account = new FixtureAccount(ctx)
    account.getPlatformSession.mockResolvedValue(session('account-a'))
    account.resolveToken.mockResolvedValue(undefined)
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    const product = new VerbooProduct(ctx, {})
    expect(await product.getPlans()).toEqual({ ok: false, code: 'signed_out' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('failure classification', () => {
  it.each([
    [404, 'not_found'],
    [503, 'unavailable'],
  ])('maps an HTTP %s read to %s', async (status, code) => {
    const ctx = new Context()
    contexts.push(ctx)
    const account = new FixtureAccount(ctx)
    account.getPlatformSession.mockResolvedValue(session('account-a'))
    account.resolveToken.mockResolvedValue('fixture-token')
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(
      async () => Response.json({ error: 'failed' }, { status }),
    ))
    const product = new VerbooProduct(ctx, {})
    expect(await product.getPlans()).toEqual({ ok: false, code })
  })

  it('reports a transport error that is not an account failure as a contract error', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const account = new FixtureAccount(ctx)
    account.getPlatformSession.mockResolvedValue(session('account-a'))
    account.resolveToken.mockResolvedValue('fixture-token')
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => { throw new Error('socket closed') }))
    const product = new VerbooProduct(ctx, {})
    expect(await product.getPlans()).toEqual({ ok: false, code: 'request_failed' })
  })

  it('treats a provider call with no HTTP status as possibly committed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const account = new FixtureAccount(ctx)
    account.getPlatformSession.mockResolvedValue(session('account-a'))
    account.resolveToken.mockResolvedValue('fixture-token')
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => { throw new Error('socket closed') }))
    const product = new VerbooProduct(ctx, {})
    await expect(product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GDRIVE_LIST', version: '20251105_01', arguments: {},
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'execution_unconfirmed' })
  })

  it('projects a priced subscription and an unpriced one', async () => {
    const billed = {
      id: '00000000-0000-4000-8000-000000000003', groupId: plan.id, group: { name: 'Pro' },
      status: 'active', currentPeriodEnd: '2026-12-05T12:00:00Z', cancelAtPeriodEnd: false,
      management: { changePlan: true },
      billing: { amountMinor: 1000, currency: 'BRL', billingInterval: 'month' as const },
    }
    const unpublished = {
      ...billed, id: '00000000-0000-4000-8000-000000000004', group: null, billing: null,
    }
    const f = fixture(
      Response.json({ data: [billed, unpublished] }),
      Response.json({ data: [plan] }),
    )
    const result = await f.product.getPlans()
    expect(result.ok && result.data.subscriptions).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000003', planId: plan.id, name: 'Pro',
        status: 'active', renewsAt: '2026-12-05T12:00:00Z', cancelAtEnd: false,
        canUpgrade: true, billing: { amountMinor: 1000, currency: 'BRL', interval: 'month' },
      },
      {
        // Without a group name the plan id names the subscription, and an
        // unpublished price leaves no billing projection.
        id: '00000000-0000-4000-8000-000000000004', planId: plan.id, name: plan.id,
        status: 'active', renewsAt: '2026-12-05T12:00:00Z', cancelAtEnd: false,
        canUpgrade: true, billing: null,
      },
    ])
  })
})

it('keeps commercial reads available when the operational fallback logger fails', async () => {
  const f = fixture(Response.json({ data: { asOf: new Date().toISOString(), trials: [], paidGroupIds: [] } }))
  const logger = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('fixture collector unavailable') })
  try { expect(await f.product.getTrialStatus(f.signal)).toMatchObject({ ok: true, data: { trials: [] } }) }
  finally { logger.mockRestore() }
})

describe('usage analytics', () => {
  const summary = { timezone: 'America/Sao_Paulo', bucket: 'day', reqTotal: 4, tokensInTotal: 1000, tokensOutTotal: 300, cachedTokens: 250, buckets: [{ bucket: '2026-11-25T00:00:00-03:00', reqCount: 4, tokensIn: 1000, tokensOut: 300, cachedTokens: 250 }] }
  it('reads scoped subscription totals and activity through the authenticated API', async () => {
    const f = fixture(Response.json({ data: summary }), Response.json({ data: summary }), Response.json({ data: [{ date: '2026-11-25', count: 4 }] }))
    const group = '00000000-0000-4000-8000-000000000001' as PlanId
    expect(await f.product.getUsageSummary('30d', null, f.signal)).toEqual({ ok: true, data: summary })
    expect(await f.product.getUsageSummary('7d', group, f.signal)).toEqual({ ok: true, data: summary })
    expect(await f.product.getUsageActivity(f.signal)).toEqual({ ok: true, data: [{ date: '2026-11-25', count: 4 }] })
    expect(String(f.fetch.mock.calls[0]?.[0])).toContain('/api/me/usage/summary?period=30d&billingMode=subscription')
    expect(String(f.fetch.mock.calls[1]?.[0])).toContain(`/api/me/groups/${group}/usage/summary?period=7d`)
    expect(String(f.fetch.mock.calls[2]?.[0])).toContain('/api/me/usage/activity?days=365&billingMode=subscription')
  })
  it('rejects malformed metrics and invalid period or group without fabricating values', async () => {
    const f = fixture(Response.json({ data: { ...summary, reqTotal: -1 } }))
    expect((await f.product.getUsageSummary('30d', null, f.signal)).ok).toBe(false)
    expect((await f.product.getUsageSummary('bad' as '30d', null, f.signal)).ok).toBe(false)
    expect((await f.product.getUsageSummary('30d', 'bad' as PlanId, f.signal)).ok).toBe(false)
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
})
