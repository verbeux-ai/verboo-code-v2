import { describe, expect, it } from 'vitest'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import {
  ACTIVE_LIMIT_HEADER,
  CREDIT_BALANCE_HEADER,
  HAS_CREDITS_HEADER,
  REACHED_TYPE_HEADER,
  UNLIMITED_HEADER,
  classifyLimit,
  creditsDepleted,
  reachedTypeOf,
} from '../src/limits.ts'

describe('[OI] subscription limit classification', () => {
  it('reads the refusal reason from the response header the backend answers with', () => {
    expect(reachedTypeOf({
      status: 429,
      message: 'rate limited',
      headers: { [REACHED_TYPE_HEADER]: 'workspace_member_usage_limit_reached' },
    })).toBe('workspace_member_usage_limit_reached')
  })

  it('reads the refusal reason the transport folds into the error text', () => {
    // An [OI]-compatible transport renders the body into the message, which is
    // the only place the structured reason survives a JSON error payload.
    expect(reachedTypeOf({
      status: 429,
      message: 'stream failed: {"error":{"rate_limit_reached_type":"workspace_owner_usage_limit_reached"}}',
    })).toBe('workspace_owner_usage_limit_reached')
  })

  it('finds the reason spelled in the message when the transport dropped the structure', () => {
    expect(reachedTypeOf({
      status: 429,
      message: 'refused: workspace_member_credits_depleted',
    })).toBe('workspace_member_credits_depleted')
  })

  it('reports no reason when the refusal names none', () => {
    expect(reachedTypeOf({ status: 429, message: 'too many requests' })).toBeUndefined()
    expect(reachedTypeOf({ status: 500, message: 'upstream error' })).toBeUndefined()
  })

  it('classifies an exhausted usage window as QUOTA, which resets on its own', () => {
    for (const reason of [
      'workspace_owner_usage_limit_reached',
      'workspace_member_usage_limit_reached',
    ]) {
      expect(classifyLimit({ status: 429, message: 'refused', headers: { [REACHED_TYPE_HEADER]: reason } }))
        .toBe(QUOTA_EXCEEDED_CODE)
    }
  })

  it('classifies depleted credits as ACCOUNT_QUOTA, which only billing restores', () => {
    expect(classifyLimit({
      status: 429,
      message: 'refused',
      headers: { [REACHED_TYPE_HEADER]: 'workspace_member_credits_depleted' },
    })).toBe(ACCOUNT_QUOTA_EXCEEDED_CODE)
    // The header the backend sends on an answered request is authoritative too.
    expect(classifyLimit({ status: 429, message: 'refused', headers: { [HAS_CREDITS_HEADER]: 'false' } }))
      .toBe(ACCOUNT_QUOTA_EXCEEDED_CODE)
    expect(classifyLimit({ status: 429, message: 'You are out of credits for this workspace' }))
      .toBe(ACCOUNT_QUOTA_EXCEEDED_CODE)
  })

  it('keeps a transient 429 transient so the retry policy may replay it', () => {
    expect(classifyLimit({ status: 429, message: 'too many requests, slow down' })).toBeUndefined()
    expect(classifyLimit({ status: 503, message: 'service unavailable' })).toBeUndefined()
  })

  it('does not read a limit out of wording on a response that is not a refusal', () => {
    // The same words appear in ordinary diagnostics; only a refusal status may
    // promote them to a terminal classification.
    expect(classifyLimit({ status: 200, message: 'out of credits' })).toBeUndefined()
    expect(classifyLimit({ message: 'out of credits' })).toBeUndefined()
  })

  it('treats a structured reason as authoritative wherever it appears', () => {
    // The structured field is the backend stating a terminal refusal, so the
    // status gate that protects the wording fallback does not apply to it.
    expect(classifyLimit({
      status: 400,
      message: 'refused',
      headers: { [REACHED_TYPE_HEADER]: 'workspace_member_usage_limit_reached' },
    })).toBe(QUOTA_EXCEEDED_CODE)
  })

  it('reports depleted credits without needing a status', () => {
    expect(creditsDepleted({ message: 'credits depleted' })).toBe(true)
    expect(creditsDepleted({ message: 'credits exhausted' })).toBe(true)
    expect(creditsDepleted({ message: 'all good' })).toBe(false)
  })

  it('names every limit header the backend sends', () => {
    // A rename upstream would silently turn detection off, so the spellings are
    // pinned here rather than only at their use sites.
    expect([
      REACHED_TYPE_HEADER, HAS_CREDITS_HEADER, UNLIMITED_HEADER,
      CREDIT_BALANCE_HEADER, ACTIVE_LIMIT_HEADER,
    ]).toEqual([
      'x-codex-rate-limit-reached-type',
      'x-codex-credits-has-credits',
      'x-codex-credits-unlimited',
      'x-codex-credits-balance',
      'x-codex-active-limit',
    ])
  })
})
