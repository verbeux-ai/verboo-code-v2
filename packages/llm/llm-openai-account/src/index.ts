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
import { ModelAvailability, cheapestFirst, isUnsupportedModel } from './availability.ts'
import type { SweepResult } from './types.ts'
import { CATALOG_PROVIDER, Config, PROVIDER, resolveConfig } from './config.ts'
import { readUsage } from './usage.ts'
import { classifyLimit } from './limits.ts'
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
  /** Deadline one discovery request keeps, in milliseconds. */
  private readonly probeTimeoutMs = 20_000
  private readonly profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Remembered per-model verdicts for the signed-in account. */
  private readonly availability = new ModelAvailability()

  /**
   * Identifier the discovery verdicts are scoped by.
   * @returns the stored account id, or undefined while no session exists.
   */
  private async accountIdentifier(): Promise<string | undefined> {
    const service = this.ctx.get('openaiAccount')
    if (service === undefined) return undefined
    try {
      const status = await service.status()
      return status.signedIn ? status.accountId : undefined
    } catch {
      // A status read that fails means no usable session to scope by.
      return undefined
    }
  }

  /** One in-flight sweep per account, so a second trigger joins the first. */
  private sweeping: Promise<SweepResult> | undefined
  private sweepingFor: string | undefined

  /**
   * Probe every catalog model once, cheapest first, and remember the verdicts.
   *
   * Discovery spends one small request per model, so it starts with the cheapest
   * and stops the moment the provider reports a limit: spending the rest of a
   * nearly-spent window to learn what the next window would say is a poor trade.
   * @param account - identifier the verdicts are scoped by.
   * @returns what the sweep concluded.
   */
  /**
   * Discover which models this account may use, cheapest first.
   *
   * Called after a sign-in. A second trigger while a sweep runs joins it rather
   * than spending the account's quota twice.
   * @returns what the sweep concluded, or an empty result while signed out.
   */
  @Remote('discoverModels')
  async discoverModels(): Promise<SweepResult> {
    const account = await this.accountIdentifier()
    if (account === undefined) return { supported: [], unsupported: [], skipped: [], stoppedAtLimit: false }
    if (this.sweeping !== undefined && this.sweepingFor === account) return this.sweeping
    this.sweepingFor = account
    this.sweeping = this.sweep(account).finally(() => {
      this.sweeping = undefined
      this.sweepingFor = undefined
    })
    return this.sweeping
  }

  private async sweep(account: string): Promise<SweepResult> {
    const profile = this.profiles.get(CATALOG_PROVIDER)
    const installed = profile?.piProvider
    if (installed === undefined) return { supported: [], unsupported: [], skipped: [], stoppedAtLimit: false }
    const ordered = cheapestFirst(installed.getModels().map(model => ({
      id: model.id,
      input: model.cost?.input ?? 0,
    })))
    const supported: string[] = []
    const unsupported: string[] = []
    const skipped: string[] = []
    let stoppedAtLimit = false
    for (const [index, model] of ordered.entries()) {
      if (stoppedAtLimit) { skipped.push(...ordered.slice(index)); break }
      const verdict = await this.probe(model)
      if (verdict === 'supported') supported.push(model)
      else if (verdict === 'unsupported') unsupported.push(model)
      else if (verdict === 'limit') { stoppedAtLimit = true; skipped.push(...ordered.slice(index)); break }
      // An inconclusive probe records nothing and the sweep moves on.
    }
    const result: SweepResult = { supported, unsupported, skipped, stoppedAtLimit }
    this.availability.recordSweep(account, result)
    return result
  }

  /**
   * Ask the provider whether this account may use one model.
   *
   * The request is deliberately tiny: one word out, one token in, so the sweep
   * costs as little of the subscription as the protocol allows.
   * @param model - catalog model id.
   * @returns what the attempt proved.
   */
  private async probe(model: string): Promise<'supported' | 'unsupported' | 'limit' | 'unknown'> {
    let failure: string | undefined
    try {
      for await (const chunk of this.ctx.llm.stream({
        provider: PROVIDER,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
        maxTokens: 1,
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      })) {
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure?.message
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure === undefined) return 'supported'
    if (isUnsupportedModel(failure)) return 'unsupported'
    // A limit is the one failure that must stop the sweep rather than continue
    // through models that would each be refused the same way.
    if (classifyLimit({ message: failure }) !== undefined) return 'limit'
    return 'unknown'
  }

  /**
   * @param ctx - owning Cordis context.
   * @param config - plugin configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    // Typert resolves the gateway service key from source, so it must be a
    // string literal at the call site rather than a module constant.
    super(ctx, 'llmOpenaiAccount')
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
      // Discovery is scoped to the signed-in account, so a second sign-in never
      // inherits the previous one's refusals.
      accountId: () => this.accountIdentifier(),
      availability: account => this.availability.read(account),
      record: (account, model, verdict) => { this.availability.record(account, model, verdict) },
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The [OI] subscription route and its usage reading; absent in compositions without this plugin. */
    llmOpenaiAccount: OpenAiAccountRoute
  }
}
