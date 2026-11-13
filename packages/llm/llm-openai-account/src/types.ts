/**
 * Public vocabulary of the [OI] subscription route: the usage reading the Host
 * serves to clients and the optional account service this plugin consumes.
 * Types only — no runtime code.
 *
 * @module @deepseek-ai/dsh-llm-openai-account/types
 */

import type {} from '@deepseek-ai/cordis'

/**
 * One rate-limit window the subscription reports.
 *
 * A window is a rolling span (for example five hours) with a consumed
 * fraction. Every field is the provider's own reading; nothing here is
 * derived, and an absent field means the provider did not disclose it.
 */
export interface SubscriptionLimitWindow {
  /** Consumed fraction of this window, in percent from 0 through 100. */
  readonly usedPercent: number
  /** Length of the window in seconds, when the provider disclosed it. */
  readonly windowSeconds?: number
  /** Seconds until this window resets, when the provider disclosed it. */
  readonly resetAfterSeconds?: number
  /** Limit classification the provider reported for this window, verbatim. */
  readonly reachedType?: string
}

/**
 * One additional subscription limit beside the primary window, such as a
 * per-model or per-feature meter.
 */
export interface SubscriptionAdditionalLimit extends SubscriptionLimitWindow {
  /** Meter identity the provider reported, such as a model family name. */
  readonly id: string
}

/**
 * The subscription usage reading of one [OI] account.
 *
 * A reading exists only when the provider answered with a usable window; a
 * failed, unauthenticated, or unreadable read produces no reading at all
 * rather than zeroed fields, so a client can tell "no reading" from "nothing
 * used".
 */
export interface SubscriptionUsage {
  /** Consumed fraction of the primary window, in percent from 0 through 100. */
  readonly usedPercent: number
  /** Length of the primary window in seconds, when the provider disclosed it. */
  readonly windowSeconds?: number
  /** Seconds until the primary window resets, when the provider disclosed it. */
  readonly resetAfterSeconds?: number
  /** Remaining credit balance, when the provider reports credits for this plan. */
  readonly credits?: number
  /**
   * Whether the plan's credits are unlimited. Only the provider's explicit
   * `x-codex-credits-unlimited: true` header sets this; an absent header is
   * not evidence of a limit, so the field stays `false` rather than being
   * inferred either way.
   */
  readonly unlimited: boolean
  /** Plan name from the account session or the usage response, when known. */
  readonly planType?: string
  /** End of the paid subscription window, as an ISO-8601 instant, when known. */
  readonly activeUntil?: string
  /** Limit classification the provider reported for the primary window, verbatim. */
  readonly reachedType?: string
  /** Further meters the provider reports beside the primary window. */
  readonly additionalLimits?: readonly SubscriptionAdditionalLimit[]
  /** Instant this reading was taken, as an ISO-8601 instant. */
  readonly asOf: string
}

/** Local session facts an account service reports without contacting the provider. */
export interface OpenAiAccountStatus {
  /** Whether this installation holds a stored session. */
  readonly signedIn: boolean
  /** ChatGPT account identifier carried by the stored session, when known. */
  readonly accountId?: string
  /** ChatGPT plan named by the stored session, such as `team`, when known. */
  readonly planType?: string
}

/**
 * The account service this route consumes: another plugin owns the login,
 * token refresh, and durable session, and this plugin only asks for a current
 * access token. The service is optional, so a composition without it serves
 * no [OI] route instead of failing to boot.
 */
export interface OpenAiAccountService {
  /**
   * Resolve a currently valid access token.
   * @returns the bearer token, or `undefined` while no session is usable.
   */
  accessToken(): Promise<string | undefined>
  /**
   * Read the local session facts without contacting the provider.
   * @returns the stored-session snapshot.
   */
  status(): Promise<OpenAiAccountStatus>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Stored [OI] account session owned by the account plugin; absent in compositions without one. */
    openaiAccount?: OpenAiAccountService
  }
}

/** What one model-discovery sweep concluded for the signed-in account. */
export interface SweepResult {
  /** Models the provider accepted. */
  readonly supported: readonly string[]
  /** Models the provider refused for this account. */
  readonly unsupported: readonly string[]
  /** Models left unprobed because the sweep stopped. */
  readonly skipped: readonly string[]
  /** Whether the sweep stopped early on a limit rather than completing. */
  readonly stoppedAtLimit: boolean
}
