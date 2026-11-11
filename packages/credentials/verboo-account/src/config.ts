/** Deployment configuration for Verboo's public OAuth client and inference gateway. */
import Schema from '@deepseek-ai/schemastery'

/** Public endpoints and bounded account request lifetimes. */
export interface Config {
  /** Origin of the Verboo account and OAuth API. */
  apiOrigin?: string
  /** Trusted inference gateway for account grant resolution. */
  routerBaseURL?: string
  /** Registered public OAuth client identifier. */
  clientId?: string
  /** Allow cleartext loopback endpoints for local integration fixtures. */
  allowLoopbackHttp?: boolean
  /** Maximum duration in milliseconds of one account HTTP attempt. */
  requestTimeoutMs?: number
  /** Maximum duration in milliseconds of one browser login attempt. */
  attemptTimeoutMs?: number
  /** Maximum age in milliseconds of a validated model catalog. */
  catalogMaxAgeMs?: number
  /** Context window used when the model catalog omits the limit. */
  fallbackContextWindow?: number
  /** Output token limit used when the model catalog omits the limit. */
  fallbackMaxOutputTokens?: number
  /** Additional requests allowed after a malformed model tool-call response. */
  malformedResponseRetries?: number
}

/** Validated defaults for the production Verboo deployment. */
export const Config = Schema.object({
  apiOrigin: Schema.string().default('https://code.verboo.ai'),
  routerBaseURL: Schema.string().default('https://code.verboo.ai/router/v1'),
  clientId: Schema.string().default('verboo-code-cli'),
  allowLoopbackHttp: Schema.boolean().default(false),
  requestTimeoutMs: Schema.number().min(1).max(10_000).default(10_000),
  attemptTimeoutMs: Schema.number().min(1).max(600_000).default(600_000),
  catalogMaxAgeMs: Schema.number().min(1).max(300_000).default(300_000),
  fallbackContextWindow: Schema.number()
    .min(4096)
    .max(2_000_000)
    .step(1)
    .default(32_768),
  fallbackMaxOutputTokens: Schema.number()
    .min(1)
    .max(128_000)
    .step(1)
    .default(8192),
  malformedResponseRetries: Schema.number().step(1).min(0).max(1).default(1),
})

/** Resolved endpoints; no secret is configuration. */
export interface Deployment {
  apiOrigin: string
  routerBaseURL: string
  clientId: string
  requestTimeoutMs: number
  attemptTimeoutMs: number
  catalogMaxAgeMs: number
  fallbackContextWindow: number
  fallbackMaxOutputTokens: number
  malformedResponseRetries: number
}

/**
 * Resolve one deployment, allowing cleartext HTTP only for an explicit loopback fixture.
 * @param config - parsed or plain deployment configuration.
 * @returns endpoints with credentials, queries and fragments rejected.
 */
export function deploymentOf(config: Config): Deployment {
  const resolved = Config(config)
  const check = (value: string, origin: boolean): string => {
    const url = new URL(value)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (origin && url.pathname !== '/') ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && loopback && resolved.allowLoopbackHttp))
    ) {
      throw new Error('Verboo Code: invalid account deployment endpoint')
    }
    return origin ? url.origin : url.href.replace(/\/$/, '')
  }
  return {
    ...resolved,
    apiOrigin: check(resolved.apiOrigin, true),
    routerBaseURL: check(resolved.routerBaseURL, false),
  }
}
