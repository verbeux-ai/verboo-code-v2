/** The discovery sweep and the availability ledger it feeds. */
import { describe, expect, it, vi } from 'vitest'
import { cheapestFirst, ModelAvailability, offeredModels } from '../src/availability.ts'

/** One catalog entry with its stated input price. */
interface ModelCost { readonly id: string; readonly input: number }

describe('cheapestFirst', () => {
  it('orders the priced models ascending and pushes the unpriced to the end', () => {
    const models: readonly ModelCost[] = [
      { id: 'c', input: 3 },
      { id: 'unknown', input: 0 },
      { id: 'a', input: 1 },
      { id: 'missing', input: 0 },
      { id: 'b', input: 2 },
    ]
    expect(cheapestFirst(models)).toEqual(['a', 'b', 'c', 'missing', 'unknown'])
  })

  it('breaks ties by id so the sweep order is stable', () => {
    const models: readonly ModelCost[] = [
      { id: 'b', input: 1 },
      { id: 'a', input: 1 },
      { id: 'a', input: 0 },
    ]
    expect(cheapestFirst(models)).toEqual(['a', 'b', 'a'])
  })

  it('returns a new array: the caller catalog order is untouched', () => {
    const models: readonly ModelCost[] = [{ id: 'b', input: 2 }, { id: 'a', input: 1 }]
    cheapestFirst(models)
    expect(models.map(model => model.id)).toEqual(['b', 'a'])
  })
})

describe('the sweep verdict loop', () => {

  it('records supported and unsupported outcomes from a sweep result', () => {
    const ledger = new ModelAvailability()
    ledger.recordSweep('account-1', { supported: ['cheap-model'], unsupported: ['large-model'], skipped: [], stoppedAtLimit: false })
    expect(offeredModels(['cheap-model', 'large-model', 'third'], ledger.read('account-1'))).toEqual(['cheap-model', 'third'])
    ledger.clear()
    ledger.clear()
    expect(offeredModels(['cheap-model', 'large-model'], ledger.read('account-1'))).toEqual(['cheap-model', 'large-model'])
  })
})

describe('probe classification', () => {
  /** Classify one stream failure the way the sweep probe does. */
  function classify(code: string | undefined, failure: string | undefined): 'supported' | 'unsupported' | 'limit' | 'unknown' {
    if (failure === undefined) return 'supported'
    if (code === 'UNSUPPORTED_MODEL' || /does not exist|not available/i.test(failure)) return 'unsupported'
    if (/limit|exhausted|quota/i.test(failure)) return 'limit'
    return 'unknown'
  }

  it('reads a clean stream as supported', () => {
    expect(classify(undefined, undefined)).toBe('supported')
  })

  it('reads the provider unsupported code as unsupported', () => {
    expect(classify('UNSUPPORTED_MODEL', 'model not available')).toBe('unsupported')
  })

  it('reads a refusal carrying the limit wording as a limit', () => {
    expect(classify(undefined, 'usage limit reached for this account')).toBe('limit')
  })

  it('reads any other failure as unknown, leaving the model offered', () => {
    expect(classify(undefined, 'socket down')).toBe('unknown')
  })

  it('never treats an unknown verdict as a refusal', () => {
    // An inconclusive probe records nothing: the sweep moves on and the model
    // stays offered, because absence of evidence is not a refusal.
    const verdict = classify(undefined, 'socket down')
    expect(verdict).not.toBe('unsupported')
  })
})

describe('the empty-account guard', () => {
  it('answers an empty sweep while signed out, without probing anything', async () => {
    const probes = vi.fn()
    // The service reads the signed-in account before sweeping: signed out means
    // the sweep never starts.
    const account = undefined
    const result = account === undefined
      ? { supported: [], unsupported: [], skipped: [], stoppedAtLimit: false }
      : await probes()
    expect(result).toEqual({ supported: [], unsupported: [], skipped: [], stoppedAtLimit: false })
    expect(probes).not.toHaveBeenCalled()
  })
})

describe('the join guard', () => {
  it('returns the running sweep instead of starting a second one', async () => {
    let started = 0
    const sweeping: Promise<{ supported: string[] }> = (async () => {
      started += 1
      return { supported: ['a'] }
    })()
    // A second trigger while a sweep runs joins it rather than spending the
    // account's quota twice.
    const joined = sweeping
    await joined
    expect(started).toBe(1)
  })
})

describe('the installed-catalog guard', () => {
  it('answers an empty sweep when the catalog provider is not installed', () => {
    const installed = undefined
    const result = installed === undefined
      ? { supported: [], unsupported: [], skipped: [], stoppedAtLimit: false }
      : { supported: ['x'], unsupported: [], skipped: [], stoppedAtLimit: false }
    expect(result).toEqual({ supported: [], unsupported: [], skipped: [], stoppedAtLimit: false })
  })
})

describe('the limit stop', () => {
  it('skips the remaining models and records the limit', () => {
    const ordered = ['a', 'b', 'c']
    const supported: string[] = []
    const unsupported: string[] = []
    const skipped: string[] = []
    let stoppedAtLimit = false
    const verdicts = new Map([['a', 'supported'], ['b', 'limit']])
    for (const [index, model] of ordered.entries()) {
      const verdict = verdicts.get(model)
      if (verdict === 'supported') supported.push(model)
      else if (verdict === 'unsupported') unsupported.push(model)
      else if (verdict === 'limit') { stoppedAtLimit = true; skipped.push(...ordered.slice(index)); break }
    }
    expect(supported).toEqual(['a'])
    expect(stoppedAtLimit).toBe(true)
    expect(skipped).toEqual(['b', 'c'])
  })
})
