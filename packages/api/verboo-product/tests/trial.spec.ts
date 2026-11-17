import { describe, expect, it, vi } from 'vitest'
import { TrialCommerce, paymentURL } from '../src/trial.ts'
import type { PlanId, TrialId, TrialAttemptId } from '../src/types.ts'
const group = '00000000-0000-4000-8000-000000000001' as PlanId
const requestId = '00000000-0000-4000-8000-000000000003' as TrialAttemptId
const notice = {
  id: ('tokens:' + group) as TrialId,
  groupId: group,
  source: 'free_tokens',
  state: 'ended',
  tokensRemaining: 0,
}
const expiry = () => new Date(Date.now() + 300_000).toISOString()
function fixture() {
  let owner = 'a'
  const request = vi.fn(
    async (
      path: string,
      method?: string,
      body?: unknown,
      _correlation?: string,
    ): Promise<unknown> => {
      if (path === '/api/me/trial-status')
        return { data: { asOf: new Date().toISOString(), trials: [notice] } }
      if (path === '/api/me/checkout/quotes')
        return {
          data: {
            available: true,
            quoteId: 'host-only-signed-quote',
            expiresAt: expiry(),
            currency: 'usd',
            initialAmountMinor: 6900,
            renewalAmountMinor: 6900,
            paymentMethods: ['card'],
            billingInterval: 'month',
          },
        }
      if (path.endsWith('/checkout') && method === 'POST' && body)
        return {
          data: {
            mode: 'stripe',
            attemptId: requestId,
            url: 'https://checkout.stripe.com/c/pay/original',
          },
        }
      throw new Error('unexpected fixture request')
    },
  )
  const commerce = new TrialCommerce(request, async () => owner)
  return {
    request,
    commerce,
    switchAccount: () => {
      owner = 'b'
    },
    offer: () =>
      commerce.offer(notice.id, { id: group, name: 'Pro', interval: 'month' }),
  }
}
describe('native trial authorization', () => {
  it('keeps signed quotes on the Host and does not create a checkout while viewing', async () => {
    const f = fixture()
    const offer = await f.offer()
    expect(offer).toMatchObject({
      currency: 'USD',
      amountMinor: 6900,
      methods: ['card'],
      card: null,
    })
    expect(JSON.stringify(offer)).not.toContain('host-only-signed-quote')
    expect(
      f.request.mock.calls.some(([path]) => path.endsWith('/checkout')),
    ).toBe(false)
  })
  it('joins repeated clicks and charges only the explicitly displayed quote', async () => {
    const f = fixture()
    const offer = await f.offer()
    const results = await Promise.all([
      f.commerce.confirm(offer.id, 'card', requestId),
      f.commerce.confirm(offer.id, 'card', requestId),
    ])
    expect(results[0]).toEqual(results[1])
    const writes = f.request.mock.calls.filter(([path]) =>
      path.endsWith('/checkout'),
    )
    expect(writes).toHaveLength(1)
    expect(writes[0]![2]).toMatchObject({
      requestId,
      subscribeNow: true,
      checkoutQuoteId: 'host-only-signed-quote',
    })
    expect(writes[0]![3]).toBe(requestId)
  })
  it('refuses another account and payment methods absent from the quote before writing', async () => {
    const f = fixture()
    const offer = await f.offer()
    await expect(
      f.commerce.confirm(offer.id, 'pix', requestId),
    ).rejects.toThrow()
    f.switchAccount()
    await expect(
      f.commerce.confirm(offer.id, 'card', requestId),
    ).rejects.toThrow()
    expect(
      f.request.mock.calls.filter(([path]) => path.endsWith('/checkout')),
    ).toHaveLength(0)
  })
  it('requires fresh explicit confirmation when a quote expires', async () => {
    const f = fixture()
    const offer = await f.offer()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(offer.expiresAt) + 1)
    try {
      await expect(
        f.commerce.confirm(offer.id, 'card', requestId),
      ).rejects.toThrow()
    } finally {
      vi.restoreAllMocks()
    }
    expect(
      f.request.mock.calls.filter(([path]) => path.endsWith('/checkout')),
    ).toHaveLength(0)
  })
  it.each([
    'https://evil.test/pay',
    'http://checkout.stripe.com/pay',
    'https://u:p@checkout.stripe.com/pay',
  ])('rejects an untrusted payment destination: %s', (url) => {
    expect(() => paymentURL(url)).toThrow()
  })
})

it('shows a separate BRL Pix quote and cannot pay it as a USD card offer', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (path, method, body, correlation) => {
    if (
      path === '/api/me/checkout/quotes' &&
      (body as { paymentMethod?: string })?.paymentMethod === 'pix'
    )
      return {
        data: {
          available: true,
          quoteId: 'pix-quote',
          expiresAt: expiry(),
          currency: 'brl',
          initialAmountMinor: 36118,
          renewalAmountMinor: 36118,
          paymentMethods: ['pix'],
          billingInterval: 'month',
          pixAvailable: true,
          pixMandateAmountMinor: 37383,
        },
      }
    return original(path, method, body, correlation)
  })
  const offer = await f.commerce.offer(
    notice.id,
    { id: group, name: 'Pro', interval: 'month' },
    'pix',
  )
  expect(offer).toMatchObject({
    paymentMethod: 'pix',
    currency: 'BRL',
    amountMinor: 36118,
    pixMandateAmountMinor: 37383,
  })
  await expect(
    f.commerce.confirm(offer.id, 'card', requestId),
  ).rejects.toThrow()
  await f.commerce.confirm(offer.id, 'pix', requestId)
  expect(
    f.request.mock.calls.find(([path]) => path.endsWith('/checkout'))?.[2],
  ).toMatchObject({
    quotedPaymentMethod: 'pix',
    checkoutQuoteId: 'pix-quote',
    subscribeNow: true,
  })
})

it('converts a saved-card subscription only after explicit confirmation and keeps renewal separate', async () => {
  const f = fixture()
  const trial = '00000000-0000-4000-8000-000000000004' as TrialId
  f.request.mockImplementation(async (path, method) => {
    if (path === '/api/me/trial-status')
      return {
        data: {
          asOf: new Date().toISOString(),
          trials: [
            {
              id: trial,
              groupId: group,
              source: 'stripe_trial',
              state: 'ended',
              canConvert: true,
            },
          ],
        },
      }
    if (path.includes('/trial-conversion?'))
      return {
        data: {
          contractVersion: 2,
          state: 'confirm_card',
          amountCents: 6500,
          baseAmountCents: 6900,
          currency: 'USD',
          billingInterval: 'month',
          expiresAt: expiry(),
          conversionToken: 'secret-conversion',
          card: { brand: 'visa', last4: '4242' },
          paymentMethods: ['saved_card'],
        },
      }
    if (path.endsWith('/card/confirm') && method === 'POST')
      return { data: { status: 'completed', attemptId: requestId } }
    throw new Error('unexpected fixture')
  })
  const offer = await f.commerce.offer(trial, {
    id: group,
    name: 'Pro',
    interval: 'month',
  })
  expect(offer).toMatchObject({
    card: { brand: 'visa', last4: '4242' },
    amountMinor: 6500,
    renewalAmountMinor: 6900,
  })
  expect(JSON.stringify(offer)).not.toContain('secret-conversion')
  expect(
    f.request.mock.calls.some(([path]) => path.endsWith('/card/confirm')),
  ).toBe(false)
  expect(await f.commerce.confirm(offer.id, 'card', requestId)).toMatchObject({
    status: 'completed',
    attemptId: requestId,
  })
})

it('offers a fresh Pix quote as an alternative to a saved card for a token trial', async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (path, method, body, correlation) => {
    if (path === '/api/me/trial-status') return { data: { asOf: new Date().toISOString(), trials: [{ ...notice, hasSavedCard: true }] } }
    if (path === '/api/me/free-tokens/activation') return { data: { token: 'activation-secret', attemptId: requestId, groupId: group, amountCents: 6900, renewalAmountCents: 6900, currency: 'usd', billingInterval: 'month', expiresAt: expiry(), card: { brand: 'visa', last4: '4242' } } }
    const result = await original(path, method, body, correlation)
    if (path === '/api/me/checkout/quotes') return { data: { ...(result as { data: object }).data, pixAvailable: true } }
    return result
  })
  const offer = await f.offer()
  expect(offer).toMatchObject({ pixAvailable: true, card: { last4: '4242' }, attemptId: requestId })
  expect(f.request.mock.calls.some(([path]) => path.endsWith('/activate'))).toBe(false)
})

it('never opens a parallel Pix acquisition for a live legacy Stripe trial', async () => {
  const f = fixture()
  const trial = '00000000-0000-4000-8000-000000000004' as TrialId
  f.request.mockResolvedValue({ data: { asOf: new Date().toISOString(), trials: [{ id: trial, groupId: group, source: 'stripe_trial', state: 'ended', canConvert: true }] } })
  await expect(f.commerce.offer(trial, { id: group, name: 'Pro', interval: 'month' }, 'pix')).rejects.toThrow()
  expect(f.request).toHaveBeenCalledTimes(1)
})

it('binds the first request identity even if the provider response is lost', async () => {
  const f = fixture()
  const offer = await f.offer()
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation(async (path, method, body, correlation) => {
    if (path.endsWith('/checkout')) throw new Error('response lost after provider accepted')
    return original(path, method, body, correlation)
  })
  await expect(f.commerce.confirm(offer.id, 'card', requestId)).rejects.toThrow()
  await expect(f.commerce.confirm(offer.id, 'card', '00000000-0000-4000-8000-000000000009' as TrialAttemptId)).rejects.toThrow()
  expect(f.request.mock.calls.filter(([path]) => path.endsWith('/checkout'))).toHaveLength(1)
})

it.each(['choose_payment', 'pix_pending', 'requires_action'] as const)('keeps %s separate from a charge authorization', async (state) => {
  const f = fixture()
  const trial = '00000000-0000-4000-8000-000000000004' as TrialId
  f.request.mockImplementation(async (path, method) => {
    if (path === '/api/me/trial-status') return { data: { asOf: new Date().toISOString(), trials: [{ id: trial, groupId: group, source: 'stripe_trial', state: 'ended', canConvert: true }] } }
    if (path.includes('/trial-conversion?')) return { data: {
      contractVersion: 2, state, amountCents: 6900, currency: 'usd', billingInterval: 'month',
      expiresAt: expiry(), conversionToken: 'host-secret', attemptId: requestId,
      ...(state === 'choose_payment' ? {} : { hostedInvoiceUrl: 'https://invoice.stripe.com/original' }),
    } }
    if (path.endsWith('/card/setup') && method === 'POST') return { data: { url: 'https://checkout.stripe.com/setup' } }
    throw new Error('No other financial operation is authorized')
  })
  const offer = await f.commerce.offer(trial, { id: group, name: 'Pro', interval: 'month' })
  if (state === 'choose_payment') {
    expect(offer.card).toBeNull()
    expect(await f.commerce.confirm(offer.id, 'card', requestId)).toMatchObject({ status: 'setup_required' })
  } else {
    expect(offer.pending).toMatchObject({ attemptId: requestId, url: 'https://invoice.stripe.com/original' })
    await expect(f.commerce.confirm(offer.id, 'card', requestId)).rejects.toThrow()
  }
  expect(f.request.mock.calls.some(([path]) => path.endsWith('/card/confirm') || path.endsWith('/checkout'))).toBe(false)
})
