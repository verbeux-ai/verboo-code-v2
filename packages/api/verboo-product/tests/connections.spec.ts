import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountSessionId } from '@deepseek-ai/dsh-deepseek-account/types'
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
 * Serve one `/api/me/connections` payload to the product service.
 * @param toolkits - the catalog entries the backend returns.
 * @returns the service, the recorded fetch, and a request signal.
 */
function fixture(toolkits: unknown[]) {
  const ctx = new Context()
  contexts.push(ctx)
  const account = new FixtureAccount(ctx)
  account.getPlatformSession.mockResolvedValue(session('account-a'))
  account.resolveToken.mockResolvedValue('fixture-token')
  const body = { data: { available: true, toolkits, accounts: [] } }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body))
  vi.stubGlobal('fetch', fetch)
  const product = new VerbooProduct(ctx, {})
  return { product, fetch, signal: new AbortController().signal }
}

describe('service catalog brand marks', () => {
  it('carries the catalog mark to the Client', async () => {
    const f = fixture([{
      slug: 'googledrive', name: 'Google Drive', available: true, authType: 'oauth',
      logo: 'https://logos.example.test/googledrive.svg',
    }])
    const result = await f.product.getConnections()
    expect(result).toEqual({
      ok: true,
      data: {
        available: true,
        accounts: [],
        toolkits: [{
          slug: 'googledrive', name: 'Google Drive', available: true, authType: 'oauth',
          logo: 'https://logos.example.test/googledrive.svg',
        }],
      },
    })
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['blank', ''],
  ])('reads a %s mark as no mark', async (_label, logo) => {
    const f = fixture([{ slug: 'linear', name: 'Linear', available: true, logo }])
    const result = await f.product.getConnections()
    expect(result.ok).toBe(true)
    expect(result.ok && result.data.toolkits[0]).toEqual({
      slug: 'linear', name: 'Linear', available: true, logo: undefined,
    })
  })

  it('drops a mark the catalog did not declare', async () => {
    const f = fixture([{
      slug: 'notion', name: 'Notion', available: true,
      logo: 'https://logos.example.test/notion.svg', undocumented: 'never-return',
    }])
    const result = await f.product.getConnections()
    expect(result.ok && result.data.toolkits[0]).not.toHaveProperty('undocumented')
  })

  it.each([
    ['a relative reference', '/assets/notion.svg'],
    ['a non-absolute value', 'notion'],
    ['an oversized value', `https://logos.example.test/${'a'.repeat(2048)}.svg`],
  ])('rejects %s instead of inventing a mark', async (_label, logo) => {
    const f = fixture([{ slug: 'notion', name: 'Notion', available: true, logo }])
    expect(await f.product.getConnections()).toEqual({ ok: false, code: 'contract_error' })
  })

  it('does not repeat marks in the model-facing public service list', async () => {
    const f = fixture([{
      slug: 'searxng', name: 'SearXNG', available: true, authType: 'none',
      logo: 'https://logos.example.test/searxng.svg',
    }])
    const listing = await f.product.listAgentConnections(f.signal)
    expect(JSON.parse(listing)).toEqual({
      available: true,
      accounts: [],
      publicServices: [{ id: 'public_searxng', toolkit: 'searxng', label: 'SearXNG' }],
    })
  })
})
