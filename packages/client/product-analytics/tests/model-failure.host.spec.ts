import { describe, expect, it } from 'vitest'
import type { AssistantStreamRecord, LlmFailure } from '@deepseek-ai/dsh-llm'
import { analyticsIdentifier, desktopModelFailureEvent, failureFromAttempt } from '../src/model-failure.ts'

describe('desktop model failure telemetry', () => {
  it.each([
    ['INVALID_REQUEST', 400, 'invalid_request', 'INVALID_REQUEST', false],
    ['MALFORMED_RESPONSE', undefined, 'malformed_response', 'MALFORMED_RESPONSE', true],
    ['TIMEOUT', undefined, 'timeout', 'TIMEOUT', true],
    ['network_error', undefined, 'network', 'TRANSPORT', true],
    ['timeout_error', undefined, 'timeout', 'TIMEOUT', true],
    ['REQUEST_TIMEOUT', undefined, 'timeout', 'TIMEOUT', true],
    ['TRANSPORT', undefined, 'network', 'TRANSPORT', true],
    ['INVALID_CREDENTIAL', 401, 'auth', 'AUTH', false],
    ['TOKEN_EXPIRED', 401, 'auth', 'AUTH', false],
    ['API_KEY_INVALID', 401, 'auth', 'AUTH', false],
    ['RATE_LIMIT', 429, 'rate_limit', 'RATE_LIMIT', true],
    ['FREE_TOKENS_ACCOUNTING_PENDING', 503, 'accounting_pending', 'ACCOUNTING_PENDING', true],
    ['SERVER', 503, 'upstream', 'SERVER', true],
    ['PROVIDER_SPECIFIC_UNKNOWN', undefined, 'unknown', 'OTHER', false],
  ] as const)('maps %s into a bounded diagnostic', (code, status, errorClass, errorCode, retryable) => {
    const failure: LlmFailure = { code, message: 'private provider error body', ...(status === undefined ? {} : { status }) }
    const event = desktopModelFailureEvent(failure, {
      timestamp: 123,
      provider: 'deepseek-account',
      model: 'pro/deepseek-v4.1-flash',
      appVersion: '0.2.2-alpha.23',
    })
    expect(event).toMatchObject({ errorClass, errorCode, retryable, timestamp: 123 })
    expect(JSON.stringify(event)).not.toContain('private provider error body')
    expect(event).not.toHaveProperty('message')
    if (status !== undefined) expect(event.httpStatus).toBe(status)
  })

  it('does not include identifiers outside the bounded telemetry alphabet', () => {
    expect(analyticsIdentifier('pro/deepseek-v4.1-flash')).toBe('pro/deepseek-v4.1-flash')
    expect(analyticsIdentifier('https://provider.invalid?key=secret')).toBeUndefined()
    expect(analyticsIdentifier('x'.repeat(121))).toBeUndefined()
  })

  it('reads only a terminal error chunk and ignores successful or aborted finishes', () => {
    const failed: AssistantStreamRecord[] = [
      { type: 'tool-call-chunks', time0: 1, index: 0, dt: [0], id: 'private-call-id' as never,
        name: 'private-tool-name', args: ['{"secret":"private-tool-arguments"}'] },
      { type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: 'private' } } } },
    ]
    expect(failureFromAttempt(failed)).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(failureFromAttempt([{ type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: 'stop' } } }])).toBeUndefined()
    expect(failureFromAttempt([{ type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } } }])).toBeUndefined()
    expect(failureFromAttempt([])).toBeUndefined()
  })
})
