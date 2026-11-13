/** Limit classification and usage parsing, independent of any transport. */
import { describe, expect, it } from 'vitest'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { classifyLimit, creditsDepleted, reachedTypeOf } from '../src/limits.ts'
import { unlimitedOf, usageFromHeaders, usageOf } from '../src/usage.ts'

describe('limit classification', () => {
  it('reads the reached reason from the response header before the body', () => {
    expect(reachedTypeOf({
      message: '{"rate_limit_reached_type":"workspace_owner_usage_limit_reached"}',
      headers: { 'x-codex-rate-limit-reached-type': 'workspace_member_credits_depleted' },
    })).toBe('workspace_member_credits_depleted')
  })

  it('ignores a blank reached-type header and falls back to the body', () => {
    expect(reachedTypeOf({
      message: '{"rate_limit_reached_type":"workspace_owner_usage_limit_reached"}',
      headers: { 'X-Codex-Rate-Limit-Reached-Type': '   ' },
    })).toBe('workspace_owner_usage_limit_reached')
  })

  it('classifies any quota wording the backend names as its reached reason', () => {
    expect(classifyLimit({
      message: 'request refused',
      headers: { 'x-codex-rate-limit-reached-type': 'quota_exceeded' },
    })).toBe(QUOTA_EXCEEDED_CODE)
  })

  it('reads the reason from the structured body field when no header is present', () => {
    expect(reachedTypeOf({
      message: '429: {"error":{"rate_limit_reached_type":"workspace_member_usage_limit_reached"}}',
    })).toBe('workspace_member_usage_limit_reached')
  })

  it('classifies a workspace usage limit as QUOTA', () => {
    expect(classifyLimit({
      status: 429,
      message: '{"rate_limit_reached_type":"workspace_owner_usage_limit_reached"}',
    })).toBe(QUOTA_EXCEEDED_CODE)
    expect(classifyLimit({
      status: 429,
      message: 'request refused',
      headers: { 'x-codex-rate-limit-reached-type': 'workspace_member_usage_limit_reached' },
    })).toBe(QUOTA_EXCEEDED_CODE)
  })

  it('classifies depleted credits as ACCOUNT_QUOTA', () => {
    expect(classifyLimit({
      status: 429,
      message: '{"rate_limit_reached_type":"workspace_member_credits_depleted"}',
    })).toBe(ACCOUNT_QUOTA_EXCEEDED_CODE)
    expect(classifyLimit({ status: 429, message: 'your credits are depleted' })).toBe(ACCOUNT_QUOTA_EXCEEDED_CODE)
    expect(classifyLimit({
      status: 429,
      message: 'request refused',
      headers: { 'x-codex-credits-has-credits': 'false' },
    })).toBe(ACCOUNT_QUOTA_EXCEEDED_CODE)
    expect(creditsDepleted({ status: 402, message: 'out of credits' })).toBe(true)
  })

  it('leaves a transient 429 retryable', () => {
    expect(classifyLimit({ status: 429, message: 'Rate limit reached for requests, please retry later' })).toBeUndefined()
    expect(classifyLimit({ status: 429, message: 'service unavailable, try again' })).toBeUndefined()
  })

  it('classifies quota wording a transport preserved from the body', () => {
    expect(classifyLimit({ message: 'insufficient_quota: you exceeded your current quota' })).toBe(QUOTA_EXCEEDED_CODE)
    expect(classifyLimit({ message: 'plain transport failure' })).toBeUndefined()
  })

  it('recovers the retry class the transport flattened into its 429 sentence', () => {
    expect(classifyLimit({ status: 429, message: 'You have hit your ChatGPT usage limit (plus plan).' })).toBe('RATE_LIMIT')
    expect(classifyLimit({
      status: 429,
      message: 'You have hit your ChatGPT usage limit (plus plan). Try again in ~5 min.',
    })).toBe(QUOTA_EXCEEDED_CODE)
  })
})

describe('usage reading', () => {
  it('parses the documented usage document', () => {
    expect(usageOf({
      asOf: '2026-11-13T00:00:00.000Z',
      headers: { 'x-codex-credits-unlimited': 'true', 'x-codex-credits-balance': '42' },
      body: {
        plan_type: 'plus',
        active_until: '2026-12-01T00:00:00.000Z',
        rate_limit: {
          used_percent: 37.5,
          limit_window_seconds: 18_000,
          reset_after_seconds: 900,
          rate_limit_reached_type: 'workspace_owner_usage_limit_reached',
        },
        additional_rate_limits: [{ id: 'gpt-5.5', used_percent: 12, limit_window_seconds: 3_600 }],
      },
    })).toEqual({
      usedPercent: 37.5,
      windowSeconds: 18_000,
      resetAfterSeconds: 900,
      credits: 42,
      unlimited: true,
      planType: 'plus',
      activeUntil: '2026-12-01T00:00:00.000Z',
      reachedType: 'workspace_owner_usage_limit_reached',
      additionalLimits: [{ id: 'gpt-5.5', usedPercent: 12, windowSeconds: 3_600 }],
      asOf: '2026-11-13T00:00:00.000Z',
    })
  })

  it('reports no reading when the document names no usable window', () => {
    expect(usageOf({ asOf: '2026-11-13T00:00:00.000Z', body: {} })).toBeUndefined()
    expect(usageOf({ asOf: '2026-11-13T00:00:00.000Z', body: { rate_limit: { used_percent: 240 } } })).toBeUndefined()
    expect(usageOf({ asOf: '2026-11-13T00:00:00.000Z', body: 'not a document' })).toBeUndefined()
  })

  it('keeps the reading when only the headers carry a window', () => {
    expect(usageFromHeaders({
      'x-codex-active-limit': 'workspace_member_usage_limit_reached',
      'x-codex-credits-unlimited': 'true',
    })).toBeUndefined()
    expect(usageOf({
      asOf: '2026-11-13T00:00:00.000Z',
      headers: { 'x-codex-active-limit': 'workspace_member_usage_limit_reached' },
      body: { used_percent: 88 },
    })).toMatchObject({ usedPercent: 88, reachedType: 'workspace_member_usage_limit_reached' })
  })

  it('never infers unlimited from an absent header', () => {
    expect(unlimitedOf(undefined)).toBe(false)
    expect(unlimitedOf({})).toBe(false)
    expect(unlimitedOf({ 'x-codex-credits-unlimited': 'false' })).toBe(false)
    expect(unlimitedOf({ 'x-codex-credits-unlimited': 'maybe' })).toBe(false)
    expect(unlimitedOf({ 'x-codex-credits-unlimited': 'TRUE' })).toBe(true)
    expect(usageOf({
      asOf: '2026-11-13T00:00:00.000Z',
      body: { used_percent: 1 },
    })?.unlimited).toBe(false)
  })
})

describe('limit classification, plain-text evidence', () => {
  it('reads a reason the provider spelled into its own text', () => {
    expect(reachedTypeOf({ message: 'refused: workspace_owner_usage_limit_reached' }))
      .toBe('workspace_owner_usage_limit_reached')
    expect(classifyLimit({ message: 'refused: workspace_member_usage_limit_reached' })).toBe(QUOTA_EXCEEDED_CODE)
  })
})
