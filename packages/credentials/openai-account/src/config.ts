/** Deployment configuration for the public [OI] OAuth client used by the Codex-compatible login. */
import Schema from '@deepseek-ai/schemastery'

/** Public endpoints, client identity, and bounded lifetimes for one login. */
export interface Config {
  /** Authorization endpoint the browser is sent to. */
  authorizeUrl?: string
  /** Token endpoint for the authorization-code exchange and refresh rotation. */
  tokenUrl?: string
  /** Revocation endpoint called when a stored grant is removed. */
  revokeUrl?: string
  /** Public OAuth client identifier. */
  clientId?: string
  /** Scopes requested for the login; `openid` and `offline_access` are required. */
  scopes?: string[]
  /** Allow cleartext loopback endpoints for local integration fixtures. */
  allowLoopbackHttp?: boolean
  /** Maximum duration in milliseconds of one account HTTP request. */
  requestTimeoutMs?: number
  /** Maximum duration in milliseconds of one browser login attempt. */
  attemptTimeoutMs?: number
  /** Remaining access-token lifetime in milliseconds that forces a refresh. */
  refreshLeewayMs?: number
}

/** Scopes the refresh rotation depends on; a login without them cannot renew itself. */
const REQUIRED_SCOPES: readonly string[] = ['openid', 'offline_access']

/** Validated defaults for the [OI] deployment. */
export const Config = Schema.object({
  authorizeUrl: Schema.string().default('https://auth.openai.com/oauth/authorize'),
  tokenUrl: Schema.string().default('https://auth.openai.com/oauth/token'),
  revokeUrl: Schema.string().default('https://auth.openai.com/oauth/revoke'),
  clientId: Schema.string().default('app_EMoamEEZ73f0CkXaXp7hrann'),
  scopes: Schema.array(Schema.string()).default([
    'openid',
    'profile',
    'email',
    'offline_access',
  ]),
  allowLoopbackHttp: Schema.boolean().default(false),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(10_000),
  attemptTimeoutMs: Schema.number().min(1).max(900_000).default(300_000),
  refreshLeewayMs: Schema.number().min(0).max(600_000).default(60_000),
})

/** Resolved endpoints and lifetimes; no secret is configuration. */
export interface Deployment {
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly revokeUrl: string
  readonly clientId: string
  readonly scopes: readonly string[]
  readonly requestTimeoutMs: number
  readonly attemptTimeoutMs: number
  readonly refreshLeewayMs: number
}

/**
 * Resolve one deployment, allowing cleartext HTTP only for an explicit loopback fixture.
 * @param config - parsed or plain deployment configuration.
 * @returns absolute endpoints without credentials, queries, or fragments.
 * @throws Error when an endpoint is not an absolute allowed URL, the client id is blank, the scope list is empty, or a required scope is missing.
 */
export function deploymentOf(config: Config = {}): Deployment {
  const resolved = Config(config)
  const endpoint = (value: string, field: string): string => {
    let url: URL
    try {
      url = new URL(value)
    } catch (cause) {
      throw new Error(`[OI] account: ${field} is not an absolute URL`, { cause })
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && loopback && resolved.allowLoopbackHttp))
    ) {
      throw new Error(`[OI] account: ${field} is not an allowed OAuth endpoint`)
    }
    return url.href
  }
  const scopes = [...new Set(resolved.scopes)]
  if (scopes.length === 0 || scopes.some(scope => scope.trim().length === 0))
    throw new Error('[OI] account: scopes must be a non-empty list of OAuth scope tokens')
  for (const scope of REQUIRED_SCOPES) {
    if (!scopes.includes(scope))
      throw new Error(`[OI] account: scopes must include ${scope}`)
  }
  if (resolved.clientId.trim().length === 0)
    throw new Error('[OI] account: clientId must not be blank')
  return {
    authorizeUrl: endpoint(resolved.authorizeUrl, 'authorizeUrl'),
    tokenUrl: endpoint(resolved.tokenUrl, 'tokenUrl'),
    revokeUrl: endpoint(resolved.revokeUrl, 'revokeUrl'),
    clientId: resolved.clientId,
    scopes,
    requestTimeoutMs: resolved.requestTimeoutMs,
    attemptTimeoutMs: resolved.attemptTimeoutMs,
    refreshLeewayMs: resolved.refreshLeewayMs,
  }
}
