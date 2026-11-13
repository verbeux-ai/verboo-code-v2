/**
 * The [OI] subscription provider route.
 *
 * Registers the `openai-account` route on `ctx.llm`, serving the GPT models of
 * a ChatGPT plan through the installed `openai-codex` catalog and the
 * `openai-codex-responses` protocol, and exposes the subscription's usage
 * reading to Host consumers.
 *
 * The account plugin owns the login, the token refresh, and the durable
 * session; this plugin consumes the optional `ctx.openaiAccount` service, so a
 * composition without one serves no ChatGPT model instead of failing to boot.
 * A subscription refusal reaches the harness as `QUOTA` (the plan's usage
 * window is spent) or `ACCOUNT_QUOTA` (the account's credits are depleted),
 * both terminal, while a transient 429 stays `RATE_LIMIT` and keeps the
 * default retry policy.
 *
 * ```yaml
 * - id: llm-openai-account
 *   name: '@deepseek-ai/dsh-llm-openai-account'
 *   config:
 *     usageTimeoutMs: 10000
 * ```
 *
 * @module @deepseek-ai/dsh-llm-openai-account
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { DISPLAY_NAME, OpenAiAccountAdapter } from './adapter.ts'
import { CATALOG_PROVIDER, Config, PROVIDER, resolveConfig } from './config.ts'
import { readUsage } from './usage.ts'
import type { SubscriptionUsage } from './types.ts'

export { Config, BASE_URL, CATALOG_PROVIDER, PROVIDER, USAGE_PATH } from './config.ts'
export type { Config as ConfigShape, ResolvedConfig } from './config.ts'
export { CREDITS_MESSAGE, DISPLAY_NAME, SIGN_IN_MESSAGE, USAGE_LIMIT_MESSAGE } from './adapter.ts'
export { classifyLimit, creditsDepleted, reachedTypeOf } from './limits.ts'
export type { LimitEvidence } from './limits.ts'
export { unlimitedOf, usageFromHeaders, usageOf } from './usage.ts'
export type {
  OpenAiAccountService,
  OpenAiAccountStatus,
  SubscriptionAdditionalLimit,
  SubscriptionLimitWindow,
  SubscriptionUsage,
} from './types.ts'

/** Cordis service key, which is also the Remote wire namespace of this plugin. */
const SERVICE_KEY = 'openaiAccount'

/**
 * Credential reference the pi-ai route must name so its provider accepts the
 * per-request account token. Nothing is read from this environment variable:
 * the account service owns the credential, and naming a reference is what
 * makes pi-ai honour the request-level token instead of its own OAuth store.
 */
const TOKEN_REF = 'CHATGPT_ACCESS_TOKEN'

/**
 * The `openai-account` route and its usage reading.
 *
 * The adapter registers with this plugin's fiber, so disposal withdraws the
 * route; the usage method never throws, because a reading is display data and
 * a failed read must not fail the caller's request.
 */
export class OpenAiAccountRoute extends TypertRemoteService {
  static inject = ['llm']
  static Config = Config

  private readonly usageTimeoutMs: number
  private readonly profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>

  /**
   * @param ctx - owning Cordis context.
   * @param config - plugin configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, SERVICE_KEY)
    this.usageTimeoutMs = resolveConfig(config).usageTimeoutMs
    // One route over the installed catalog: the catalog supplies the endpoint,
    // the wire protocol, and the GPT model list, so this profile states only
    // what this deployment decides — the route label and the credential the
    // request carries.
    this.profiles = resolveProfiles({
      [CATALOG_PROVIDER]: { apiKeyEnv: TOKEN_REF, displayName: DISPLAY_NAME },
    })
    ctx.llm.registerAdapter([PROVIDER], new OpenAiAccountAdapter({
      profiles: () => this.profiles,
      accessToken: () => this.accessToken(),
      resolveAttachments: () => ctx.get('attachments'),
    }))
  }

  /**
   * Resolve the current account access token.
   * @returns the bearer token, or `undefined` while no session is usable.
   */
  private async accessToken(): Promise<string | undefined> {
    const account = this.ctx.get('openaiAccount')
    if (account === undefined) return undefined
    return account.accessToken()
  }

  /**
   * Read the subscription usage of the signed-in account.
   *
   * Absent, signed-out, failed, or unreadable reads produce `undefined`; the
   * method never throws, so a client renders nothing instead of a zeroed
   * meter. The reading carries no token, request text, or account secret.
   * @param signal - caller cancellation; an aborted read yields no reading.
   * @returns the usage reading, or `undefined` when none could be obtained.
   */
  @Remote('usage')
  async usage(signal: AbortSignal): Promise<SubscriptionUsage | undefined> {
    signal.throwIfAborted()
    const account = this.ctx.get('openaiAccount')
    if (account === undefined) return undefined
    let token: string | undefined
    let accountId: string | undefined
    try {
      token = await account.accessToken()
      accountId = (await account.status()).accountId
    } catch {
      // A rejected refresh or an unavailable credential store means this read
      // has no credential; the account plugin reports that failure to the human.
      return undefined
    }
    if (token === undefined || token.length === 0) return undefined
    return readUsage({
      accessToken: token,
      ...accountId === undefined ? {} : { accountId },
      timeoutMs: this.usageTimeoutMs,
      signal,
    })
  }
}

export default OpenAiAccountRoute
