// @vitest-environment jsdom
/**
 * The composer's external-subscription control: it stays absent until the
 * reading matters, and it never presents a number the provider did not state.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { subscriptionUsageState, subscriptionUsageVisible } from '../src/client/subscription-usage-resource.ts'
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
    additionalLimits: [],
    asOf: '2026-11-13T02:00:00.000Z',
    ...overrides,
  }
}

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
