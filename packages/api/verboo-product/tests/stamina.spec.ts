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
const reading = {
  groupId: '00000000-0000-4000-8000-000000000001', groupName: 'Unlimited',
  remainingPercent: 50, nextOutputTps: 67, recovering: false,
  fullAt: null, accountingPending: false, asOf: '2026-11-04T15:00:00Z',
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
function fixture(body: unknown = { data: [reading] }, status = 200) {
  const ctx = new Context()
  contexts.push(ctx)
  const account = new FixtureAccount(ctx)
  account.getPlatformSession.mockResolvedValue(session('account-a'))
  account.resolveToken.mockResolvedValue('fixture-token')
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }))
  vi.stubGlobal('fetch', fetch)
  const product = new VerbooProduct(ctx, {})
  return { account, product, fetch, signal: new AbortController().signal }
}

describe('public enrolled-plan stamina', () => {
  it('preserves server routing slugs for matching a selected model to its group ID', async () => {
    const f = fixture()
    const group = { id: reading.groupId, name: 'Max', slug: 'max' }
    f.fetch.mockImplementation(async url => Response.json({ data: String(url).includes('/me/subscriptions') ? [{
      id: reading.groupId, groupId: group.id, group, status: 'active', cancelAtPeriodEnd: false,
      management: { changePlan: false }, billing: null,
    }] : [{ ...group, description: '', priceCents: 100, currency: 'BRL', billingInterval: 'month' }] }))
    expect(await f.product.getPlans()).toMatchObject({ ok: true, data: {
      subscriptions: [{ planId: group.id, name: 'Max', slug: 'max' }],
      catalog: [{ id: group.id, name: 'Max', slug: 'max' }],
    } })
  })
  it('uses Host authentication and strips all private accounting fields', async () => {
    const f = fixture({ data: [{ ...reading, budgetUsd: '100', usedUsd: '99', inputRate: 'private', secret: 'never-return' }] })
    expect(await f.product.getStamina(f.signal)).toEqual({ ok: true, data: [reading] })
    const [url, request] = f.fetch.mock.calls[0]!
    expect(url).toBe('https://code.verboo.ai/api/me/stamina')
    expect(new Headers(request!.headers).get('authorization')).toBe('Bearer fixture-token')
    expect(request!.redirect).toBe('error')
  })
  it.each([200, 404])('keeps non-participants and older APIs empty (HTTP %s)', async (status) => {
    const f = fixture({ data: [] }, status)
    expect(await f.product.getStamina(f.signal)).toEqual({ ok: true, data: [] })
  })
  it.each([
    { data: [{ ...reading, remainingPercent: 101 }] },
    { data: [{ ...reading, nextOutputTps: 0 }] },
    { data: [{ ...reading, nextOutputTps: 5.5 }] },
    { data: [{ ...reading, asOf: 'invalid' }] },
    { data: [{ ...reading, fullAt: 'invalid' }] },
    { data: [{ ...reading, groupId: 'invalid' }] },
    { data: [reading, reading] },
    { data: null },
  ])('rejects malformed readings without inventing stamina', async (body) => {
    const f = fixture(body)
    expect(await f.product.getStamina(f.signal)).toEqual({ ok: false, code: 'contract_error' })
  })
  it('does not confirm empty stamina during a receiver outage', async () => {
    const f = fixture({ error: 'unavailable' }, 503)
    expect(await f.product.getStamina(f.signal)).toEqual({ ok: false, code: 'unavailable' })
    expect(f.fetch).toHaveBeenCalledTimes(3)
  })
  it('rejects a response from the previous login', async () => {
    const f = fixture()
    f.fetch.mockImplementationOnce(async () => {
      f.account.getPlatformSession.mockResolvedValue(session('account-b'))
      return Response.json({ data: [reading] })
    })
    expect(await f.product.getStamina(f.signal)).toEqual({ ok: false, code: 'account_changed' })
  })
  it('captures the owning login before resolving its token', async () => {
    const f = fixture()
    f.account.resolveToken.mockImplementationOnce(async () => {
      f.account.getPlatformSession.mockResolvedValue(session('account-b'))
      return 'previous-login-token'
    })
    expect(await f.product.getStamina(f.signal)).toEqual({ ok: false, code: 'account_changed' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('never queries stamina while signed out', async () => {
    const f = fixture()
    f.account.getPlatformSession.mockResolvedValue(null)
    expect(await f.product.getStamina(f.signal)).toEqual({ ok: false, code: 'signed_out' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('only rejects the token that received an explicit authentication failure', async () => {
    const f = fixture({ error: 'unauthorized' }, 401)
    expect(await f.product.getStamina(f.signal)).toEqual({ ok: false, code: 'signed_out' })
    expect(f.account.rejectToken).toHaveBeenCalledWith('fixture-token')
    expect(f.fetch).toHaveBeenCalledOnce()
  })
  it('cancels the owning read without retrying it', async () => {
    const f = fixture()
    const entered = Promise.withResolvers<undefined>()
    f.fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { reject(new Error('Fixture read cancelled')) }, { once: true })
      entered.resolve(undefined)
    }))
    const controller = new AbortController()
    const read = f.product.getStamina(controller.signal)
    await entered.promise
    controller.abort()
    expect(await read).toEqual({ ok: false, code: 'account_changed' })
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(f.account.rejectToken).not.toHaveBeenCalled()
  })
})
