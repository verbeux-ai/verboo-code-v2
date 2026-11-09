import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountSessionId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ConnectionId, PlanId } from '../src/types.ts'
import { VerbooProduct } from '../src/index.ts'

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
  const product = new VerbooProduct(ctx, {})
  return { product, fetch, signal: new AbortController().signal }
}

const link = (url: string, id: string | null = null): Response => Response.json({
  data: { url, expiresAt: '2026-11-05T12:00:00Z', id },
})

const plan = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Pro', description: 'Pro',
  priceCents: 1000, currency: 'BRL', billingInterval: 'month',
}

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

  it('reports a provider refusal as a failed action', async () => {
    const f = fixture(Response.json({ data: { successful: false, result: 'denied' } }))
    await expect(f.product.executeAgentConnection({
      connectionId: 'ca_work', slug: 'GDRIVE_LIST', version: '20251105_01', arguments: {},
    }, f.signal)).rejects.toMatchObject({ code: 'action_failed' })
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
