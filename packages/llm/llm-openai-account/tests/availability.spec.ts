/**
 * Model discovery: a model is offered until the provider refuses it for this
 * account, and a refusal is remembered rather than re-probed.
 */
import { describe, expect, it } from 'vitest'
import { ModelAvailability, isUnsupportedModel, offeredModels } from '../src/availability.ts'

/** The provider's own wording for a model this account may not use. */
const REFUSAL = "Codex error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."

describe('refusal detection', () => {
  it('recognises the provider refusing a model for this account', () => {
    expect(isUnsupportedModel(REFUSAL)).toBe(true)
  })

  it('does not read a transient failure as a refusal', () => {
    // A rate limit or a network fault must never remove a model from the menu.
    expect(isUnsupportedModel('rate limit reached, retry later')).toBe(false)
    expect(isUnsupportedModel('fetch failed')).toBe(false)
    expect(isUnsupportedModel('')).toBe(false)
  })
})

describe('what the menu offers', () => {
  it('offers the whole catalog before any probe', () => {
    // Hiding unprobed models would empty the menu before the first turn.
    expect(offeredModels(['a', 'b'], undefined)).toEqual(['a', 'b'])
  })

  it('withholds only the models the provider refused', () => {
    const store = new ModelAvailability()
    store.record('acct-1', 'b', 'unsupported')
    store.record('acct-1', 'a', 'supported')
    expect(offeredModels(['a', 'b', 'c'], store.read('acct-1'))).toEqual(['a', 'c'])
  })

  it('keeps a model the provider accepted', () => {
    const store = new ModelAvailability()
    store.record('acct-1', 'a', 'supported')
    expect(offeredModels(['a'], store.read('acct-1'))).toEqual(['a'])
  })
})

describe('scoping and lifetime', () => {
  it('never lends one account the refusals of another', () => {
    const store = new ModelAvailability()
    store.record('acct-1', 'a', 'unsupported')
    // A second sign-in must see the full catalog, not the previous verdicts.
    expect(store.read('acct-2')).toBeUndefined()
    expect(offeredModels(['a', 'b'], store.read('acct-2'))).toEqual(['a', 'b'])
  })

  it('forgets verdicts once they are stale', () => {
    let now = 0
    const store = new ModelAvailability(1000, () => now)
    store.record('acct-1', 'a', 'unsupported')
    expect(store.read('acct-1')).toBeDefined()
    now = 1001
    // A model list changes upstream; a stale refusal must not outlive it.
    expect(store.read('acct-1')).toBeUndefined()
  })

  it('reports nothing while signed out', () => {
    const store = new ModelAvailability()
    store.record('acct-1', 'a', 'unsupported')
    expect(store.read(undefined)).toBeUndefined()
  })

  it('drops everything on sign-out', () => {
    const store = new ModelAvailability()
    store.record('acct-1', 'a', 'unsupported')
    store.clear()
    expect(store.read('acct-1')).toBeUndefined()
  })

  it('records nothing for an inconclusive probe', () => {
    const store = new ModelAvailability()
    store.record('acct-1', 'a', 'unknown')
    // An inconclusive probe must leave the model offered.
    expect(offeredModels(['a'], store.read('acct-1'))).toEqual(['a'])
  })
})
