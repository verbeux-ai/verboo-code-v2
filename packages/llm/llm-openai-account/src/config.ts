/**
 * Configuration for the [OI] subscription route.
 *
 * The endpoint and the usage path are protocol facts of the [OI] Codex
 * backend, so they stay fixed; a deployment varies only the deadline of the
 * usage read.
 *
 * @module @deepseek-ai/dsh-llm-openai-account/config
 */

import Schema from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Provider route key this plugin registers on `ctx.llm`. */
export const PROVIDER = 'openai-account'

/**
 * pi-ai's installed catalog provider serving the Codex responses protocol.
 * Its entry carries the endpoint, the wire protocol, and the GPT model
 * catalog, so this route composes over it instead of restating them.
 */
export const CATALOG_PROVIDER = 'openai-codex'

/** Base URL of the [OI] Codex backend, the destination of model and usage requests. */
export const BASE_URL = 'https://chatgpt.com/backend-api'

/** Path of the subscription usage reading, relative to {@link BASE_URL}. */
export const USAGE_PATH = '/codex/usage'

/** Default deadline in milliseconds of one usage read. */
export const DEFAULT_USAGE_TIMEOUT_MS = 10_000

/** Configuration accepted by this plugin. */
export interface Config {
  /** Deadline in milliseconds of one usage read; a read that exceeds it yields no reading. */
  usageTimeoutMs?: number
}

/** Runtime schema for {@link Config}. */
export const Config = Schema.object({
  usageTimeoutMs: Schema.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_USAGE_TIMEOUT_MS),
})

/** Validated configuration with every default resolved. */
export interface ResolvedConfig {
  /** Positive deadline in milliseconds of one usage read. */
  readonly usageTimeoutMs: number
}

/**
 * Resolve the configured defaults.
 * @param config - parsed plugin configuration.
 * @returns the resolved configuration.
 * @throws Error when the deadline is not a positive finite number within the timer bound.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const usageTimeoutMs = config.usageTimeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS
  if (!Number.isFinite(usageTimeoutMs) || usageTimeoutMs <= 0 || usageTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-openai-account: usageTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return { usageTimeoutMs }
}
