import type { AssistantStreamRecord, LlmFailure } from '@deepseek-ai/dsh-llm'

/** Bounded classes accepted by the Verboo desktop observability endpoint. */
export type DesktopModelErrorClass =
  | 'invalid_request'
  | 'malformed_response'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'accounting_pending'
  | 'upstream'
  | 'unknown'

/** Bounded failure-code vocabulary; provider error messages never leave the client. */
export type DesktopModelErrorCode =
  | 'INVALID_REQUEST'
  | 'MALFORMED_RESPONSE'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'ACCOUNTING_PENDING'
  | 'SERVER'
  | 'OTHER'

/** Model error event sent to the first-party observability collector. */
export interface DesktopModelFailureEvent {
  kind: 'desktop_model_error'
  route: '/desktop'
  source: 'desktop'
  operation: 'stream_completion'
  errorClass: DesktopModelErrorClass
  errorCode: DesktopModelErrorCode
  retryable: boolean
  timestamp: number
  provider?: string
  model?: string
  appVersion?: string
  httpStatus?: number
}

/** Provider/model/release identifiers are retained only when they fit a strict, bounded alphabet.
 * @param value - optional identifier supplied by the model route.
 * @returns the bounded identifier, or `undefined` when it is absent or unsafe.
 */
export function analyticsIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized !== undefined && normalized.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(normalized)
    ? normalized
    : undefined
}

/** Convert an internal LLM failure into the small, content-free event vocabulary.
 * @param failure - the terminal provider failure.
 * @param details - bounded route metadata and event time.
 * @returns the normalized first-party telemetry event.
 */
export function desktopModelFailureEvent(
  failure: LlmFailure,
  details: { timestamp: number; provider?: string; model?: string; appVersion?: string },
): DesktopModelFailureEvent {
  const code = failure.code.toUpperCase().replace(/[^A-Z0-9_]/g, '')
  const accountingPending = code.includes('ACCOUNTING_PENDING')
    || /\bfree_tokens_accounting_pending\b/i.test(failure.message)
  const errorCode: DesktopModelErrorCode =
    code === 'INVALID_REQUEST' ? 'INVALID_REQUEST'
      : code === 'MALFORMED_RESPONSE' ? 'MALFORMED_RESPONSE'
        : code === 'TIMEOUT' || code === 'TIMEOUT_ERROR' || code === 'REQUEST_TIMEOUT' ? 'TIMEOUT'
          : code === 'TRANSPORT' || code === 'NETWORK' || code === 'NETWORK_ERROR' ? 'TRANSPORT'
            : code.startsWith('AUTH') || code.includes('CREDENTIAL') || code.includes('TOKEN_INVALID')
              || code.includes('TOKEN_EXPIRED') || code.includes('API_KEY') ? 'AUTH'
              : code === 'RATE_LIMIT' ? 'RATE_LIMIT'
                : accountingPending ? 'ACCOUNTING_PENDING'
                  : code === 'SERVER' || (failure.status !== undefined && failure.status >= 500) ? 'SERVER'
                    : 'OTHER'
  const errorClass: DesktopModelErrorClass =
    errorCode === 'INVALID_REQUEST' || failure.status === 400 ? 'invalid_request'
      : errorCode === 'MALFORMED_RESPONSE' ? 'malformed_response'
        : errorCode === 'TIMEOUT' || failure.status === 408 ? 'timeout'
          : errorCode === 'TRANSPORT' ? 'network'
            : errorCode === 'AUTH' || failure.status === 401 || failure.status === 403 ? 'auth'
              : errorCode === 'RATE_LIMIT' || failure.status === 429 ? 'rate_limit'
                : errorCode === 'ACCOUNTING_PENDING' ? 'accounting_pending'
                  : errorCode === 'SERVER' || (failure.status !== undefined && failure.status >= 500) ? 'upstream'
                    : 'unknown'
  const retryable = ['MALFORMED_RESPONSE', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'SERVER'].includes(errorCode)
    || failure.status === 408 || failure.status === 429 || (failure.status !== undefined && failure.status >= 500)
  const httpStatus = failure.status !== undefined && Number.isInteger(failure.status)
    && failure.status >= 400 && failure.status <= 599 ? failure.status : undefined
  const provider = analyticsIdentifier(details.provider)
  const model = analyticsIdentifier(details.model)
  const appVersion = analyticsIdentifier(details.appVersion)
  return {
    kind: 'desktop_model_error', route: '/desktop', source: 'desktop', operation: 'stream_completion',
    errorClass, errorCode, retryable, timestamp: details.timestamp,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(appVersion === undefined ? {} : { appVersion }),
    ...httpStatus === undefined ? {} : { httpStatus },
  }
}

/** Read only the terminal failure marker; model text and tool-call data are ignored.
 * @param stream - completed assistant stream records.
 * @returns the terminal failure, or `undefined` when the attempt did not fail.
 */
export function failureFromAttempt(stream: readonly AssistantStreamRecord[]): LlmFailure | undefined {
  for (let index = stream.length - 1; index >= 0; index--) {
    const record = stream[index]
    if (record?.type !== 'chunk' || record.chunk.type !== 'finish') continue
    return record.chunk.reason.kind === 'error' ? record.chunk.reason.failure : undefined
  }
  return undefined
}
