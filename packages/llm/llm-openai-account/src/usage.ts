/**
 * Reading of the [OI] subscription usage and limit headers.
 *
 * The subscription backend exposes one reading at `GET
 * {BASE_URL}/codex/usage` and repeats the governing limit facts on every
 * model response as `x-codex-*` headers. This module turns either source into
 * the single {@link SubscriptionUsage} value the Host serves, and answers
 * `undefined` whenever the facts are absent or unusable — never a zeroed
 * reading, because "nothing used" and "no reading" drive different UI.
 *
 * @module @deepseek-ai/dsh-llm-openai-account/usage
 */

import { z } from 'zod'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import {
  ACTIVE_LIMIT_HEADER,
  CREDIT_BALANCE_HEADER,
  REACHED_TYPE_HEADER,
  UNLIMITED_HEADER,
} from './limits.ts'
import { BASE_URL, USAGE_PATH } from './config.ts'
import type { SubscriptionAdditionalLimit, SubscriptionUsage } from './types.ts'

/**
 * One rate-limit window as the backend reports it. Both the snake-case
 * spelling the endpoint uses and the camel-case spelling a compatible
 * deployment may return are accepted, so a renamed field degrades to "not
 * disclosed" instead of discarding the whole reading.
 */
const windowFields = {
  used_percent: z.number().nullish(),
  usedPercent: z.number().nullish(),
  limit_window_seconds: z.number().nullish(),
  windowSeconds: z.number().nullish(),
  reset_after_seconds: z.number().nullish(),
  resetAfterSeconds: z.number().nullish(),
  reached_type: z.string().nullish(),
  rate_limit_reached_type: z.string().nullish(),
}

const windowSchema = z.object(windowFields).loose()

/**
 * The response nests its windows: `rate_limit.primary_window` carries the
 * short window governing requests and `secondary_window` the long one. The
 * flat spelling stays accepted so a deployment that hoists them still reads.
 */
const rateLimitSchema = z.object({
  ...windowFields,
  primary_window: windowSchema.nullish(),
  secondary_window: windowSchema.nullish(),
}).loose()

const creditsSchema = z.object({
  has_credits: z.boolean().nullish(),
  hasCredits: z.boolean().nullish(),
  unlimited: z.boolean().nullish(),
  // The live document reports the balance as a decimal string.
  balance: z.union([z.number(), z.string()]).nullish(),
}).loose()

const additionalSchema = z.object({
  id: z.string().nullish(),
  name: z.string().nullish(),
  meter: z.string().nullish(),
  rate_limit: windowSchema.nullish(),
  ...windowFields,
}).loose()

const usageSchema = z.object({
  plan_type: z.string().nullish(),
  planType: z.string().nullish(),
  active_until: z.string().nullish(),
  activeUntil: z.string().nullish(),
  rate_limit: rateLimitSchema.nullish(),
  credits: creditsSchema.nullish(),
  additional_rate_limits: z.array(additionalSchema).nullish(),
  ...windowFields,
}).loose()

/** Claim namespace an [OI] access token carries its account facts under. */
const AUTH_CLAIM = 'https://api.openai.com/auth'

/**
 * The claim an access token must carry for this route to address an account.
 * Only the identifier is read: the rest of the token is the account plugin's
 * business, and no other claim is needed to call the backend.
 */
const claimsSchema = z.object({
  [AUTH_CLAIM]: z.object({ chatgpt_account_id: z.string().optional() }).loose().optional(),
}).loose()

/** One parsed window's facts, with the spelling that carried each field. */
interface WindowFacts {
  readonly usedPercent?: number
  readonly windowSeconds?: number
  readonly resetAfterSeconds?: number
  readonly reachedType?: string
}

/** A percent reading is usable only as a finite number within its own scale. */
function percentOf(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined
}

/** A duration or delay is usable only as a positive finite count of seconds. */
function secondsOf(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
}

/** A non-empty identifier or reason, or nothing. */
function textOf(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/**
 * Read one window's facts from a parsed entry.
 * @param entry - the window object, either the top level or a nested `rate_limit`.
 * @returns the facts the entry disclosed.
 */
function windowFacts(entry: z.infer<typeof windowSchema> | undefined): WindowFacts {
  if (entry === undefined) return {}
  const usedPercent = percentOf(entry.used_percent ?? entry.usedPercent)
  const windowSeconds = secondsOf(entry.limit_window_seconds ?? entry.windowSeconds)
  const resetAfterSeconds = secondsOf(entry.reset_after_seconds ?? entry.resetAfterSeconds)
  const reachedType = textOf(entry.rate_limit_reached_type ?? entry.reached_type)
  return {
    ...usedPercent === undefined ? {} : { usedPercent },
    ...windowSeconds === undefined ? {} : { windowSeconds },
    ...resetAfterSeconds === undefined ? {} : { resetAfterSeconds },
    ...reachedType === undefined ? {} : { reachedType },
  }
}

/**
 * Merge one document's own window fields with its nested `rate_limit` entry.
 * The nested entry is the documented spelling, so it wins per field; the
 * top-level spelling is what a compatible deployment that flattens the
 * document returns.
 * @param outer - the parsed usage document.
 * @returns the facts either spelling disclosed.
 */
function mergedFacts(outer: z.infer<typeof usageSchema>): WindowFacts {
  const rateLimit = outer.rate_limit
  return {
    ...windowFacts(outer),
    // A hoisted deployment states the window on `rate_limit` itself; the live
    // document nests it one level deeper, and the nested spelling wins.
    ...windowFacts(rateLimit),
    ...windowFacts(rateLimit?.primary_window),
  }
}

/**
 * The long window the provider enforces beside the short one, when disclosed.
 * @param outer - the parsed usage document.
 * @returns the secondary window's facts, or undefined when it reported none.
 */
function secondaryFacts(outer: z.infer<typeof usageSchema>): (WindowFacts & { usedPercent: number }) | undefined {
  const facts = windowFacts(outer.rate_limit?.secondary_window)
  return facts.usedPercent === undefined ? undefined : { ...facts, usedPercent: facts.usedPercent }
}

/** Read one header case-insensitively from an already-collected record. */
function headerOf(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return textOf(value)
  }
  return undefined
}

/** Read a numeric header, ignoring a value that is not a finite number. */
function numericHeader(headers: Readonly<Record<string, string>> | undefined, name: string): number | undefined {
  const raw = headerOf(headers, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Whether the account's credits are unlimited.
 *
 * Only an explicit `true` counts: an absent header, a false one, or an
 * unreadable one all leave the field false, so no client shows an unlimited
 * badge because a proxy dropped a header.
 * @param headers - response headers, when the caller observed them.
 * @returns true only for an explicit unlimited claim.
 */
export function unlimitedOf(headers: Readonly<Record<string, string>> | undefined): boolean {
  return headerOf(headers, UNLIMITED_HEADER)?.toLowerCase() === 'true'
}

/**
 * Build the usage reading from the facts one source disclosed.
 *
 * The reading requires a usable primary percent; without it nothing is
 * reported, because every other field describes a window whose consumption is
 * unknown. Header facts win over body facts where both appear: the headers
 * describe the limit currently governing requests, which is newer than a
 * cached usage document.
 * @param input - response headers and the parsed usage document.
 * @returns the reading, or `undefined` when no usable window was disclosed.
 */
export function usageOf(input: {
  readonly headers?: Readonly<Record<string, string>>
  readonly body: unknown
  readonly asOf: string
}): SubscriptionUsage | undefined {
  const parsed = usageSchema.safeParse(input.body)
  if (!parsed.success) return undefined
  const document = parsed.data
  const primary = mergedFacts(document)
  const headerReachedType = headerOf(input.headers, REACHED_TYPE_HEADER)
  const reachedType = headerReachedType ?? primary.reachedType
  if (primary.usedPercent === undefined) return undefined
  const credits = balanceOf(document.credits?.balance) ?? numericHeader(input.headers, CREDIT_BALANCE_HEADER)
  const activeUntil = textOf(document.active_until ?? document.activeUntil)
  const planType = textOf(document.plan_type ?? document.planType)
  const secondary = secondaryFacts(document)
  const additionalLimits = (document.additional_rate_limits ?? []).flatMap((entry, index): SubscriptionAdditionalLimit[] => {
    const facts = windowFacts({ ...entry, ...entry.rate_limit })
    const id = textOf(entry.id ?? entry.name ?? entry.meter) ?? `${index + 1}`
    return facts.usedPercent === undefined ? [] : [{ id, ...facts, usedPercent: facts.usedPercent }]
  })
  // The active-limit header names the meter governing requests; it is only a
  // classification hint, so it is reported without inventing a window for it.
  const activeLimit = headerOf(input.headers, ACTIVE_LIMIT_HEADER)
  const reach = reachedType ?? activeLimit
  return {
    usedPercent: primary.usedPercent,
    ...primary.windowSeconds === undefined ? {} : { windowSeconds: primary.windowSeconds },
    ...primary.resetAfterSeconds === undefined ? {} : { resetAfterSeconds: primary.resetAfterSeconds },
    ...credits === undefined ? {} : { credits },
    unlimited: unlimitedOf(input.headers) || document.credits?.unlimited === true,
    ...planType === undefined ? {} : { planType },
    ...activeUntil === undefined ? {} : { activeUntil },
    ...reach === undefined ? {} : { reachedType: reach },
    // The long window is a real meter, so it is reported beside the short one
    // rather than folded into it: a reader near both needs to see both.
    ...secondary === undefined
      ? additionalLimits.length === 0 ? {} : { additionalLimits }
      : {
        additionalLimits: [
          ...additionalLimits,
          {
            id: 'secondary',
            usedPercent: secondary.usedPercent,
            ...secondary.windowSeconds === undefined ? {} : { windowSeconds: secondary.windowSeconds },
            ...secondary.resetAfterSeconds === undefined ? {} : { resetAfterSeconds: secondary.resetAfterSeconds },
          },
        ],
      },
    asOf: input.asOf,
  }
}

/**
 * Read a credit balance the provider stated.
 * @param value - the balance field, as a number or the decimal string the live document uses.
 * @returns the balance, or undefined when it stated none or it is not a number.
 */
function balanceOf(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read the ChatGPT account identifier an access token carries.
 *
 * The backend requires it beside the bearer token, and the token itself is the
 * authoritative source: the same claim is what the model transport reads, so a
 * locally stored identifier that disagrees with the token cannot address a
 * different account.
 * @param accessToken - one [OI] access token, normally a JWT.
 * @returns the account identifier, or `undefined` when the token carries none.
 */
export function accountIdFromToken(accessToken: string): string | undefined {
  const payload = accessToken.split('.')[1]
  if (payload === undefined) return undefined
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    // An opaque or malformed token carries no readable claim; the read then
    // relies on the identifier the account service reports.
    return undefined
  }
  const parsed = claimsSchema.safeParse(claims)
  if (!parsed.success) return undefined
  const accountId = parsed.data[AUTH_CLAIM]?.['chatgpt_account_id']
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined
}

/** Everything one usage read needs from the caller. */
export interface UsageReadRequest {
  /** Currently valid access token; the caller resolves it before this call. */
  readonly accessToken: string
  /** ChatGPT account identifier the backend expects in `chatgpt-account-id`; derived from the token when omitted. */
  readonly accountId?: string
  /** Deadline in milliseconds of this one read. */
  readonly timeoutMs: number
  /** Caller cancellation, combined with the deadline. */
  readonly signal?: AbortSignal
}

/**
 * Read the subscription usage from the backend.
 *
 * Every failure — no response, a body this build cannot read, a deadline, or a
 * caller cancellation — yields `undefined`. The reading is display data, so a
 * failed read must not surface as a request failure and must never be replaced
 * by a zeroed reading.
 *
 * A refusal still contributes what it discloses: its headers, and a body that
 * happens to parse. The backend answers an exhausted account with the limit it
 * enforced, which is the state a client most needs to show.
 * @param request - the resolved credential and read bounds.
 * @returns the reading, or `undefined` when no usable reading was obtained.
 */
export async function readUsage(request: UsageReadRequest): Promise<SubscriptionUsage | undefined> {
  const timeout = AbortSignal.timeout(request.timeoutMs)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  const accountId = request.accountId ?? accountIdFromToken(request.accessToken)
  const headers: Record<string, string> = {
    ...attributionHeaders(),
    accept: 'application/json',
    authorization: `Bearer ${request.accessToken}`,
    ...accountId === undefined ? {} : { 'chatgpt-account-id': accountId },
  }
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${USAGE_PATH}`, { method: 'GET', headers, signal })
  } catch (error) {
    // Transport failure, deadline, or caller cancellation: this read produced
    // no facts, which is exactly what `undefined` reports.
    void error
    return undefined
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A refusal body is frequently plain text; its headers still describe the
    // governing limit, so an unreadable body is not a failed read by itself.
    body = {}
  }
  return usageOf({ headers: Object.fromEntries(response.headers), body, asOf: new Date().toISOString() })
}

/**
 * Read the headers a model response carries about the governing limit.
 * @param headers - the response headers of one model call.
 * @returns the reading those headers alone support, or `undefined` when they name no window.
 */
export function usageFromHeaders(headers: Readonly<Record<string, string>>): SubscriptionUsage | undefined {
  return usageOf({ headers, body: {}, asOf: new Date().toISOString() })
}
