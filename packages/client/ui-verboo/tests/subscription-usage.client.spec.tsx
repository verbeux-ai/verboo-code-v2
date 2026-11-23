// @vitest-environment jsdom
/**
 * The composer's external-subscription control: it stays absent until the
 * reading matters, and it never presents a number the provider did not state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AccountCredentialRevision, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  createSubscriptionUsageResource, subscriptionUsageAddress, subscriptionUsageState, subscriptionUsageVisible,
} from '../src/client/subscription-usage-resource.ts'
import type { SubscriptionUsage as Reading } from '../src/client/subscription-usage-resource.ts'

afterEach(cleanup)

/** A confirmed reading with the fields a healthy window reports. */
function reading(overrides: Partial<Reading> = {}): Reading {
  return {
    usedPercent: 42,
    windowSeconds: 18_000,
    resetAfterSeconds: 3_600,
    credits: 12_480,
    unlimited: false,
    planType: 'team',
    activeUntil: '2027-03-12T00:00:00+00:00',
    additionalLimits: [{ id: 'gpt-5', usedPercent: 12 }],
    asOf: '2026-11-13T02:00:00.000Z',
    ...overrides,
  }
}

function usageOwner(id: string, revision: string): Parameters<typeof subscriptionUsageAddress>[0] {
  return {
    view: {
      status: 'credential-stored', credentialRevision: revision as AccountCredentialRevision,
      attempt: null, links: { usageUrl: '', topUpUrl: '' },
    },
    profile: { id: id as AccountUserId, name: null, contact: null },
  }
}

it('binds a polling address to the accepted revision and profile', () => {
  const owner = usageOwner('account / a', 'rev / 1')
  expect(subscriptionUsageAddress(owner)).toBe('dsh-resource://verboo-subscription-usage/rev%20%2F%201/account%20%2F%20a')
  expect(subscriptionUsageAddress({ ...owner, view: null })).toBe('')
  expect(subscriptionUsageAddress({
    ...owner, view: { status: 'credential-stored', attempt: null, links: owner.view!.links },
  })).toBe('')
  expect(subscriptionUsageAddress({ ...owner, profile: null })).toBe('')
  expect(subscriptionUsageAddress({ ...owner, profile: { ...owner.profile!, id: null } })).toBe('')
})

it('recovers subscription readings after offline and transport failures without leaking them to a new account', async () => {
  vi.useFakeTimers()
  let online = false
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  const ctx = new Context()
  const registry = new ResourceRegistry(ctx)
  const account = createSnapshotStore(usageOwner('account-a', '1'))
  const modelReading = reading({ usedPercent: 80 })
  const read = vi.fn<Parameters<typeof createSubscriptionUsageResource>[0]>()
    .mockResolvedValueOnce({ ok: true, value: undefined })
    .mockResolvedValue({ ok: true, value: modelReading })
  const usage = createSubscriptionUsageResource(read, account, 2000)
  const unregister = registry.register(usage.provider)
  const source = registry.source(subscriptionUsageAddress(account.getSnapshot()))
  const releases = [source.subscribe(() => {})]
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(read).not.toHaveBeenCalled()
    expect(source.getSnapshot()).toMatchObject({ status: 'failed', failure: { details: { reason: 'offline' } } })
    online = true
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot()).toMatchObject({ status: 'failed', failure: { details: { reason: 'unreported' } } })
    usage.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot()).toMatchObject({ status: 'live', value: modelReading })

    const failure = new RemoteError('verboo/subscription-usage-unavailable', 'Fixture refusal', { reason: 'contract_error' })
    read.mockResolvedValueOnce({ ok: false, error: failure })
    await vi.advanceTimersByTimeAsync(2000)
    expect(source.getSnapshot()).toEqual({ status: 'failed', value: modelReading, failure })
    read.mockRejectedValueOnce(new Error('private transport detail'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(source.getSnapshot()).toMatchObject({
      status: 'failed', value: modelReading,
      failure: { message: 'Subscription usage refresh is unavailable.', details: { reason: 'contract_error' } },
    })

    read.mockResolvedValueOnce({ ok: true, value: reading({ usedPercent: 20 }) })
    account.set(usageOwner('account-b', '2'))
    const next = registry.source(subscriptionUsageAddress(account.getSnapshot()))
    expect(next.getSnapshot()).toMatchObject({ value: undefined })
    releases.push(next.subscribe(() => {}))
    await vi.advanceTimersByTimeAsync(0)
    expect(next.getSnapshot()).toMatchObject({ status: 'live', value: { usedPercent: 20 } })
    expect(source.getSnapshot()).toMatchObject({ status: 'failed', value: modelReading })
    const empty = usage.provider.open('', { signal: new AbortController().signal })[Symbol.asyncIterator]()
    expect(await empty.next()).toMatchObject({ done: true })
  } finally {
    for (const release of releases) release()
    unregister()
    await vi.advanceTimersByTimeAsync(0)
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

describe('subscription usage classification', () => {
  it('reports unavailable when no reading was obtained, never zero percent', () => {
    expect(subscriptionUsageState(undefined)).toBe('unavailable')
    expect(subscriptionUsageVisible('unavailable')).toBe(false)
  })

  it('stays silent on a healthy window so the dock keeps its resting height', () => {
    const state = subscriptionUsageState(reading({ usedPercent: 12 }))
    expect(state).toBe('normal')
    expect(subscriptionUsageVisible(state)).toBe(false)
  })

  it('warns from eighty percent, before the window is actually spent', () => {
    expect(subscriptionUsageState(reading({ usedPercent: 80 }))).toBe('warn')
    expect(subscriptionUsageVisible('warn')).toBe(true)
  })

  it('reports exhausted when the provider names a reached limit', () => {
    expect(subscriptionUsageState(reading({ usedPercent: 40, reachedType: 'workspace_owner_usage_limit_reached' })))
      .toBe('exhausted')
    expect(subscriptionUsageState(reading({ usedPercent: 100 }))).toBe('exhausted')
  })

  it('reports unlimited only when the reading says so', () => {
    expect(subscriptionUsageState(reading({ unlimited: true }))).toBe('unlimited')
    // A full window is not an unlimited plan, and an absent reading is not one either.
    expect(subscriptionUsageState(reading({ usedPercent: 100 }))).not.toBe('unlimited')
    expect(subscriptionUsageState(undefined)).not.toBe('unlimited')
  })

  it('keeps the states a Verboo route can never paint out of the visible set', () => {
    // The control is exclusive to the external route; a Verboo model shows the
    // stamina instead, so only these three states ever render a pill.
    const visible = (['normal', 'warn', 'exhausted', 'unlimited', 'unavailable'] as const)
      .filter(state => subscriptionUsageVisible(state))
    expect(visible).toEqual(['warn', 'exhausted', 'unlimited'])
  })
})

describe('subscription usage copy', () => {
  it('always pairs a percentage with the word that says what it measures', async () => {
    const { en } = await import('../src/client/locales.ts')
    const copy = en['subscription.used']
    // A bare "%" reads as the stamina's remaining share; the word disambiguates.
    expect(copy).toContain('{percent}%')
    expect(copy).toContain('used')
    expect(copy).toContain('{plan}')
  })

  it('names the external plan in every state so it cannot read as a Verboo plan', async () => {
    const { en, pt } = await import('../src/client/locales.ts')
    for (const dictionary of [en, pt]) {
      for (const key of ['subscription.used', 'subscription.exhausted', 'subscription.unlimited'] as const) {
        expect(dictionary[key]).toContain('{plan}')
      }
    }
  })

  it('offers a route out of the limit instead of only reporting it', async () => {
    const { en, pt } = await import('../src/client/locales.ts')
    expect(en['quota.switchModel']).toBeTruthy()
    expect(pt['quota.switchModel']).toBeTruthy()
    expect(en['quota.openAiBody']).toContain('Verboo')
  })
})
