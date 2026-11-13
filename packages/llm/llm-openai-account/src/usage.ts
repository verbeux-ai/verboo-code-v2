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
  HAS_CREDITS_HEADER,
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
  used_percent: z.number().optional(),
  usedPercent: z.number().optional(),
  limit_window_seconds: z.number().optional(),
  windowSeconds: z.number().optional(),
  reset_after_seconds: z.number().optional(),
  resetAfterSeconds: z.number().optional(),
  reached_type: z.string().optional(),
  rate_limit_reached_type: z.string().optional(),
}

const windowSchema = z.object(windowFields).loose()

const creditsSchema = z.object({
  has_credits: z.boolean().optional(),
  hasCredits: z.boolean().optional(),
  unlimited: z.boolean().optional(),
  balance: z.number().optional(),
}).loose()

const additionalSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  meter: z.string().optional(),
  rate_limit: windowSchema.optional(),
  ...windowFields,
}).loose()

const usageSchema = z.object({
  plan_type: z.string().optional(),
  planType: z.string().optional(),
  active_until: z.string().optional(),
  activeUntil: z.string().optional(),
  rate_limit: windowSchema.optional(),
  rate_limit_reached_type: z.string().optional(),
  credits: creditsSchema.optional(),
  additional_rate_limits: z.array(additionalSchema).optional(),
  ...windowFields,
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
  const primary = windowFacts({ ...document, ...document.rate_limit })
  const headerReachedType = headerOf(input.headers, REACHED_TYPE_HEADER)
  const reachedType = headerReachedType ?? primary.reachedType
  if (primary.usedPercent === undefined) return undefined
  const credits = document.credits?.balance ?? numericHeader(input.headers, CREDIT_BALANCE_HEADER)
  const activeUntil = textOf(document.active_until ?? document.activeUntil)
  const planType = textOf(document.plan_type ?? document.planType)
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
    unlimited: unlimitedOf(input.headers),
    ...planType === undefined ? {} : { planType },
    ...activeUntil === undefined ? {} : { activeUntil },
    ...reach === undefined ? {} : { reachedType: reach },
    ...additionalLimits.length === 0 ? {} : { additionalLimits },
    asOf: input.asOf,
  }
}

/** Everything one usage read needs from the caller. */
export interface UsageReadRequest {
  /** Currently valid access token; the caller resolves it before this call. */
  readonly accessToken: string
  /** ChatGPT account identifier the backend expects in `chatgpt-account-id`. */
  readonly accountId?: string
  /** Deadline in milliseconds of this one read. */
  readonly timeoutMs: number
  /** Caller cancellation, combined with the deadline. */
  readonly signal?: AbortSignal
}

/**
 * Read the subscription usage from the backend.
 *
 * Every failure — no response, a non-success status, a body this build cannot
 * read, a deadline, or a caller cancellation — yields `undefined`. The reading
 * is display data, so a failed read must not surface as a request failure and
 * must never be replaced by a zeroed reading.
 * @param request - the resolved credential and read bounds.
 * @returns the reading, or `undefined` when no usable reading was obtained.
 */
export async function readUsage(request: UsageReadRequest): Promise<SubscriptionUsage | undefined> {
  const timeout = AbortSignal.timeout(request.timeoutMs)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  const headers: Record<string, string> = {
    ...attributionHeaders(),
    accept: 'application/json',
    authorization: `Bearer ${request.accessToken}`,
    ...request.accountId === undefined ? {} : { 'chatgpt-account-id': request.accountId },
  }
  let response: Response
  let body: unknown
  try {
    response = await fetch(`${BASE_URL}${USAGE_PATH}`, { method: 'GET', headers, signal })
    if (!response.ok) {
      // The headers still describe the governing limit on a refusal, which is
      // the state a client most needs to show.
      const observed = Object.fromEntries(response.headers)
      return usageOf({ headers: observed, body: {}, asOf: new Date().toISOString() })
    }
    body = await response.json()
  } catch (error) {
    // Transport failure, deadline, or caller cancellation: all of them mean
    // this read produced no facts, which is exactly what `undefined` reports.
    void error
    return undefined
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
