/**
 * Classification of [OI] subscription limit failures into the harness
 * provider-neutral codes.
 *
 * The Codex backend reports an exhausted subscription as an HTTP 429 whose
 * body names why it was refused. Two outcomes differ in what the caller can do
 * next, and both are terminal for the route:
 *
 * - `QUOTA` (`QUOTA_EXCEEDED_CODE`): the plan's usage window is spent. Waiting
 *   for the window to reset restores the route; retrying the same request does
 *   not.
 * - `ACCOUNT_QUOTA` (`ACCOUNT_QUOTA_EXCEEDED_CODE`): the account's credits are
 *   depleted, which the human replenishes through billing. The account route
 *   distinguishes it from `QUOTA` because the remedy is a purchase, not a wait.
 *
 * A 429 that names no limit stays `RATE_LIMIT`, which the retry policy treats
 * as transient. Both codes above are outside that policy's retryable set, so a
 * refused subscription is never replayed.
 *
 * @module @deepseek-ai/dsh-llm-openai-account/limits
 */

import { isQuotaExceededError } from '@deepseek-ai/dsh-llm'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'

/** Response header naming why the backend refused a subscription request. */
export const REACHED_TYPE_HEADER = 'x-codex-rate-limit-reached-type'

/** Response header reporting whether the account still holds credits. */
export const HAS_CREDITS_HEADER = 'x-codex-credits-has-credits'

/** Response header reporting whether the account's credits are unlimited. */
export const UNLIMITED_HEADER = 'x-codex-credits-unlimited'

/** Response header carrying the remaining credit balance. */
export const CREDIT_BALANCE_HEADER = 'x-codex-credits-balance'

/** Response header naming the limit currently governing the account. */
export const ACTIVE_LIMIT_HEADER = 'x-codex-active-limit'

/**
 * Limit reasons the backend reports through `rate_limit_reached_type`.
 * The names are the binary's own spellings, so they are matched verbatim.
 */
const CREDITS_DEPLETED_REASONS: readonly string[] = [
  'workspace_member_credits_depleted',
]

/** Reasons that identify an exhausted usage window rather than depleted credits. */
const USAGE_LIMIT_REASONS: readonly string[] = [
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]

/** Field name the backend uses for the refusal reason, in a body or a message. */
const REACHED_TYPE_FIELD = 'rate_limit_reached_type'

/** Wording that names depleted credits without the structured field. */
const CREDITS_DEPLETED_WORDING = /\bcredits?[\s_-]+(?:depleted|exhausted)\b|\bout[\s_-]+of[\s_-]+credits\b/i

/**
 * One refusal's observable facts. The message is the provider's rendered error
 * text, which for an [OI]-compatible transport carries the response body.
 */
export interface LimitEvidence {
  /** HTTP status of the refused request, when the transport reported one. */
  readonly status?: number
  /** Provider error text, including the response body when the transport carried it. */
  readonly message: string
  /** Response headers, when the caller observed them. */
  readonly headers?: Readonly<Record<string, string>>
}

/** Read one header case-insensitively from an already-collected record. */
function headerOf(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

/**
 * Extract the refusal reason from an error text or a header record.
 *
 * The backend states it as a JSON field in the body, which an [OI]-compatible
 * transport folds into the error message, and as a response header on the
 * requests it answers directly.
 * @param evidence - the refusal facts.
 * @returns the reason string, or `undefined` when the refusal names none.
 */
export function reachedTypeOf(evidence: LimitEvidence): string | undefined {
  const header = headerOf(evidence.headers, REACHED_TYPE_HEADER)
  if (header !== undefined && header.trim().length > 0) return header.trim()
  const field = new RegExp(String.raw`"${REACHED_TYPE_FIELD}"\s*:\s*"([^"]+)"`).exec(evidence.message)
  if (field?.[1] !== undefined) return field[1]
  for (const reason of [...CREDITS_DEPLETED_REASONS, ...USAGE_LIMIT_REASONS]) {
    if (evidence.message.includes(reason)) return reason
  }
  return undefined
}

/**
 * Whether the evidence reports depleted credits, which only billing restores.
 * @param evidence - the refusal facts.
 * @returns true when the account's credits are exhausted.
 */
export function creditsDepleted(evidence: LimitEvidence): boolean {
  const reason = reachedTypeOf(evidence)
  if (reason !== undefined && CREDITS_DEPLETED_REASONS.includes(reason)) return true
  const hasCredits = headerOf(evidence.headers, HAS_CREDITS_HEADER)
  if (hasCredits !== undefined && hasCredits.trim().toLowerCase() === 'false') return true
  return CREDITS_DEPLETED_WORDING.test(evidence.message)
}

/**
 * Classify a refusal as a terminal subscription limit.
 *
 * A status is required for the wording-based fallback, because the same words
 * can appear in an unrelated diagnostic; the structured reason is trusted
 * wherever it appears.
 * @param evidence - the refusal facts.
 * @returns `ACCOUNT_QUOTA` for depleted credits, `QUOTA` for an exhausted
 *   window, and `undefined` when the refusal names no limit and stays
 *   transient.
 */
export function classifyLimit(evidence: LimitEvidence): string | undefined {
  // A structured reason or a credits header is the backend stating a terminal
  // refusal, so either classifies wherever it appears. Wording alone is not
  // evidence: the same phrases show up in ordinary diagnostics and in answered
  // requests, so it only counts on a refusal status.
  const refusal = evidence.status === 429 || evidence.status === 402
  const structured = reachedTypeOf(evidence) !== undefined
    || headerOf(evidence.headers, HAS_CREDITS_HEADER) !== undefined
  if (!refusal && !structured) return undefined
  if (creditsDepleted(evidence)) return ACCOUNT_QUOTA_EXCEEDED_CODE
  const reason = reachedTypeOf(evidence)
  if (reason !== undefined && (USAGE_LIMIT_REASONS.includes(reason) || isQuotaExceededError(reason))) {
    return QUOTA_EXCEEDED_CODE
  }
  if (refusal && isQuotaExceededError(evidence.message)) return QUOTA_EXCEEDED_CODE
  return undefined
}
