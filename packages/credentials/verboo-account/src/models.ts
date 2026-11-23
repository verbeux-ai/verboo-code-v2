/** Account-bound OpenAI-compatible model discovery using the existing pi-ai transport. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { z } from 'zod'
import { LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  LlmModelInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  GenerateOptions,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import { PiAiAdapter, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type {
  PiAiModelProfile,
  ResolvedPiAiProviderProfile,
} from '@deepseek-ai/dsh-llm-pi-ai'
import { Config, deploymentOf } from './config.ts'
import type { Deployment } from './config.ts'
import { AccountRequestError, observe, operation, VerbooHttp } from './http.ts'

export { Config } from './config.ts'
export const name = 'llm-verboo-account'
export const inject = ['llm', 'deepseekAccount']

// Preserve the account route of saved sessions while changing its provider and display identity.
const PROVIDER = 'deepseek-account'
const number = z.number().positive().optional()
const listing = z.object({
  data: z
    .array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().optional(),
          display_name: z.string().optional(),
          displayName: z.string().optional(),
          context_length: number,
          context_window: number,
          contextWindow: number,
          max_output_tokens: number,
          max_tokens: number,
          maxOutputTokens: number,
          vision: z.boolean().optional(),
          // Accepted as the router spells it and read defensively below: a
          // capability hint must never fail the whole listing, which would leave
          // the account with no models at all.
          reasoning: z.union([z.boolean(), z.object({}).loose()]).optional(),
        })
        .loose(),
    )
    .max(2000),
})

/** The thinking levels the pi-ai adapter can name on the wire, in escalation order. */
const DISPATCH_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One level the pi-ai adapter can spell. */
type DispatchLevel = typeof DISPATCH_LEVELS[number]

/**
 * Translate the levels the router accepts into the map pi-ai dispatches through.
 *
 * The router names its levels in its own vocabulary and sends the level itself
 * as the wire value. The adapter reads a level absent from the map as
 * unsupported, so only the offered levels appear; pinning the rest to `null`
 * would instead mean "offered, sends nothing", which the adapter refuses for
 * every level but `off` and which fails the whole listing. `off` is the one
 * level that legitimately sends nothing, so it alone carries `null`.
 *
 * A listing offering nothing beyond `off` leaves the field absent: the adapter
 * refuses a declaration with no thinking level, and absence keeps whatever the
 * installed catalog says instead of naming a capability the route lacks.
 * @param reasoning - the listing's reasoning field, a bare flag or the level object.
 * @returns the offered levels keyed by name, or `undefined` when the router named none.
 */
function reasoningEffortsOf(
  reasoning: unknown,
): Partial<Record<DispatchLevel, string | null>> | undefined {
  if (reasoning === null || typeof reasoning !== 'object' || Array.isArray(reasoning)) return undefined
  const record = reasoning as Record<string, unknown>
  const named = [record['effort_levels'], record['effortLevels']].find(Array.isArray)
  if (named === undefined) return undefined
  const offered = named
    // Anything that is not a string names no level this adapter can spell.
    .filter((level): level is string => typeof level === 'string')
    .map(level => level.trim().toLowerCase())
    .filter((level): level is DispatchLevel => DISPATCH_LEVELS.some(known => known === level))
  if (!offered.some(level => level !== 'off')) return undefined
  return Object.fromEntries(
    offered.map(level => [level, level === 'off' ? null : level]),
  )
}

/**
 * Keep exact server model IDs, including plan prefixes; capabilities never depend on a name guess.
 * @param value - untrusted gateway response.
 * @param deployment - conservative defaults for legacy listings without capability metadata.
 * @returns transport model profiles in the server's order.
 */
export function parseModels(
  value: unknown,
  deployment: Deployment,
): PiAiModelProfile[] {
  const response = listing.safeParse(value)
  if (!response.success) throw new AccountRequestError('contract_error')
  const ids = new Set<string>()
  return response.data.data.map((row) => {
    if (ids.has(row.id)) throw new AccountRequestError('contract_error')
    ids.add(row.id)
    const efforts = reasoningEffortsOf(row.reasoning)
    const contextWindow =
      row.contextWindow ??
      row.context_length ??
      row.context_window ??
      deployment.fallbackContextWindow
    return {
      id: row.id,
      name: row.displayName ?? row.display_name ?? row.name ?? row.id,
      contextWindow,
      maxTokens: Math.min(
        row.maxOutputTokens ??
          row.max_output_tokens ??
          row.max_tokens ??
          deployment.fallbackMaxOutputTokens,
        contextWindow,
      ),
      input: row.vision ? ['text', 'image'] : ['text'],
      reasoning: row.reasoning === true || typeof row.reasoning === 'object',
      // Absent when the router named no levels, so the adapter keeps whatever
      // the installed catalog declares instead of inventing a set.
      ...efforts === undefined ? {} : { reasoningEfforts: efforts },
    }
  })
}

/** Keep transport credential fallback closed for the account-owned model route. */
export function verbooModelAuth() {
  return {
    credentials: {
      list: () => Promise.resolve([]),
      read: () => Promise.resolve(undefined),
      modify: () => Promise.reject(new LlmError(
        'A sessão é gerenciada pelo Verboo Code.',
        'ACCOUNT_SIGN_IN_REQUIRED',
      )),
      delete: () => Promise.resolve(undefined),
    },
    authContext: {
      env: () => Promise.resolve(undefined),
      fileExists: () => Promise.resolve(false),
    },
  }
}

/** The shared transport with discovery and each prepared request bound to one account credential. */
class VerbooAdapter extends PiAiAdapter {
  private loaded: { sessionId: string; at: number } | undefined
  private pending: { sessionId: string; generation: AbortSignal; work: Promise<boolean> } | undefined
  private readonly lifetime = new AbortController()
  private generation = new AbortController()

  /**
 * @param ctx - owning LLM and account services.
 * @param deployment - validated gateway configuration.
 */
  constructor(
    private readonly ctx: Context,
    private readonly deployment: Deployment,
  ) {
    const normalRetry = resolveRetryPolicy({ mode: 'normal' }, 'verboo-account retryPolicy')
    const tokens = new WeakMap<ResolvedPiAiProviderProfile, string>()
    const state = { profiles: new Map<string, ResolvedPiAiProviderProfile>() }
    super({
      profiles: () => state.profiles,
      resolveApiKey: async (_provider, profile) => {
        const expected = tokens.get(profile)
        const current = await ctx.deepseekAccount.resolveToken(
          deployment.routerBaseURL,
        )
        const session = await ctx.deepseekAccount.getPlatformSession()
        if (
          expected === undefined ||
          current === undefined ||
          session?.sessionId !== expected
        )
          throw new LlmError(
            'Entre na sua conta Verboo para continuar.',
            'ACCOUNT_SIGN_IN_REQUIRED',
          )
        return session.token
      },
      auth: verbooModelAuth(),
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) =>
        resolveImageAttachmentAccess(attachments, () => undefined, ref),
      onMalformedResponse: ({ provider, model, category, responseId }) => {
        ctx.logger.warn('Verboo model response rejected: %o', {
          provider, model, category, ...responseId === undefined ? {} : { responseId },
        })
      },
      prepareHeaders: (request, headers) => {
        const requestId = randomUUID()
        headers.set('X-Request-Id', requestId)
        ctx.logger.info('Verboo model request: %o', {
          requestId, provider: request.provider, model: request.model,
          ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
        })
        return headers
      },
    })
    const replace = (models: PiAiModelProfile[], sessionId?: string) => {
      const profiles = resolveProfiles(
        {
          [PROVIDER]: {
            displayName: 'Verboo Code',
            api: 'openai-completions',
            baseURL: deployment.routerBaseURL,
            apiKeyEnv: 'VERBOO_ACCESS_TOKEN',
            models,
            compat: { thinkingFormat: 'deepseek' },
            retryPolicy: {
              mode: 'normal',
              maxRetries: normalRetry.maxRetries,
              retryableCodes: [...normalRetry.retryableCodes, 'MALFORMED_RESPONSE'],
              maxRetriesByCode: { MALFORMED_RESPONSE: deployment.malformedResponseRetries },
            },
          },
        },
        models.length === 0 ? 'deferred' : 'strict',
      )
      if (sessionId !== undefined)
        for (const profile of profiles.values()) tokens.set(profile, sessionId)
      state.profiles = profiles
    }
    replace([])
    this.replace = replace
    ctx.on('credentials/record-updated', (key) => {
      if (key !== 'verboo-account/default') return
      this.generation.abort()
      this.generation = new AbortController()
    })
    ctx.on('deepseek-account/signed-out', () => {
      this.loaded = undefined
      replace([])
    })
    ctx.effect(
      () => () => {
        this.lifetime.abort()
        this.generation.abort()
      },
      'Verboo model discovery',
    )
  }

  private readonly replace: (models: PiAiModelProfile[], token?: string) => void

  private async load(signal?: AbortSignal): Promise<boolean> {
    const token = await this.ctx.deepseekAccount.resolveToken(
      this.deployment.routerBaseURL,
    )
    if (token === undefined) {
      this.loaded = undefined
      this.replace([])
      return false
    }
    const generation = this.generation.signal
    const session = await this.ctx.deepseekAccount.getPlatformSession()
    if (generation.aborted || session?.sessionId === undefined || session.token !== token) return false
    const sessionId = session.sessionId
    if (
      this.loaded?.sessionId === sessionId &&
      Date.now() - this.loaded.at < this.deployment.catalogMaxAgeMs
    )
      return true
    if (this.pending?.sessionId === sessionId && this.pending.generation === generation) return this.pending.work
    if (this.loaded?.sessionId !== sessionId) {
      this.loaded = undefined
      this.replace([])
    }
    const context = operation()
    const catalogSignal = AbortSignal.any([
      this.lifetime.signal, generation, ...(signal === undefined ? [] : [signal]),
    ])
    const pending = {
      sessionId,
      generation,
      work: Promise.resolve()
        .then(async () => {
          observe(context, 'catalog', 'started')
          try {
            const response = await new VerbooHttp(this.deployment).request(
              `${this.deployment.routerBaseURL}/models`,
              {
                headers: { authorization: `Bearer ${token}` },
                signal: catalogSignal,
              },
              context,
            )
            const models = parseModels(response, this.deployment)
            const current = await this.ctx.deepseekAccount.getPlatformSession()
            if (catalogSignal.aborted || current?.sessionId !== sessionId || current.token !== token) {
              observe(
                context,
                'catalog',
                'failed',
                new AccountRequestError('request_cancelled'),
              )
              return false
            }
            this.replace(models, sessionId)
            this.loaded = { sessionId, at: Date.now() }
            observe(context, 'catalog', 'succeeded')
            return true
          } catch (error) {
            const safe =
              error instanceof AccountRequestError
                ? error
                : new AccountRequestError('contract_error')
            observe(context, 'catalog', 'failed', safe)
            if (safe.code === 'authentication_invalid')
              await this.ctx.deepseekAccount.rejectToken(token)
            throw new LlmError(
              'Não foi possível carregar os modelos da sua conta Verboo. Tente novamente.',
              'MODEL_LISTING_FAILED',
              { cause: safe },
            )
          }
        })
        .finally(() => {
          if (this.pending === pending) this.pending = undefined
        }),
    }
    this.pending = pending
    return pending.work
  }

  override async listModels(
    provider: string,
  ): Promise<readonly LlmModelInfo[]> {
    return (await this.load()) ? super.listModels(provider) : []
  }
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (!(await this.load(signal)))
      throw new LlmError(
        'Entre na sua conta Verboo para continuar.',
        'ACCOUNT_SIGN_IN_REQUIRED',
      )
    return super.resolveModel(provider, model, signal)
  }
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    if (!(await this.load(signal)))
      throw new LlmError(
        'Entre na sua conta Verboo para continuar.',
        'ACCOUNT_SIGN_IN_REQUIRED',
      )
    const prepared = await super.prepareCall(provider, model, signal)
    return {
      ...prepared,
      stream: options => streamWithVerbooAuthentication(
        this.ctx.deepseekAccount, this.deployment.routerBaseURL, () => prepared.stream(options), options.signal,
      ),
    }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!(await this.load(options.signal)))
      throw new LlmError(
        'Entre na sua conta Verboo para continuar.',
        'ACCOUNT_SIGN_IN_REQUIRED',
      )
    yield* streamWithVerbooAuthentication(
      this.ctx.deepseekAccount, this.deployment.routerBaseURL, () => super.stream(options), options.signal,
    )
  }
}


/**
 * Reauthorize an untouched inference stream only for the captured login.
 * @param account - the account service that can resolve or renew its own grant.
 * @param routerBaseURL - approved endpoint for account token resolution.
 * @param stream - factory for an exact prepared inference request.
 * @param signal - lifetime of that request.
 * @returns the original stream or one authorized replay before any output.
 */
export async function* streamWithVerbooAuthentication(
  account: Pick<DeepSeekAccount, 'getPlatformSession' | 'refreshRejectedToken'>,
  routerBaseURL: string,
  stream: () => AsyncIterable<StreamChunk>,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const session = await account.getPlatformSession()
  const pending: StreamChunk[] = []
  let outputStarted = false
  try {
    for await (const chunk of stream()) {
      if (chunk.type !== 'usage' && chunk.type !== 'finish') {
        outputStarted = true
        for (const buffered of pending) yield buffered
        pending.length = 0
        yield chunk
        continue
      }
      if (chunk.type === 'usage') {
        pending.push(chunk)
        continue
      }
      if (
        chunk.reason.kind === 'error' &&
        chunk.reason.failure.code === 'AUTH' &&
        !outputStarted &&
        session?.sessionId !== undefined &&
        session.sessionId === (await account.getPlatformSession())?.sessionId
      ) {
        let refreshed: string | undefined
        try {
          refreshed = await account.refreshRejectedToken(
            routerBaseURL,
            session.token,
            signal,
          )
        } catch (error: unknown) {
          if (error instanceof AccountRequestError && error.code === 'request_cancelled')
            throw new LlmError('Account token refresh was cancelled', 'ABORTED', { cause: error })
          throw new LlmError(
            'Could not refresh the account session. Your sign-in was kept; try the request again.',
            'ACCOUNT_REFRESH_FAILED',
            { cause: error },
          )
        }
        if (signal?.aborted)
          throw new LlmError('Account token refresh was cancelled', 'ABORTED')
        if (refreshed !== undefined) {
          const current = await account.getPlatformSession()
          if (current?.sessionId === session.sessionId) {
            yield* stream()
            return
          }
        }
        if (await account.getPlatformSession() === null)
          throw new LlmError('Your Verboo sign-in expired. Sign in again.', 'ACCOUNT_SIGN_IN_REQUIRED')
      }
      for (const buffered of pending) yield buffered
      pending.length = 0
      yield chunk
      return
    }
    for (const buffered of pending) yield buffered
  } catch (error: unknown) {
    for (const buffered of pending) yield buffered
    pending.length = 0
    if (error instanceof LlmError && error.code === 'MALFORMED_RESPONSE') {
      throw new LlmError(
        'O modelo retornou uma chamada de ferramenta inválida. Tente novamente.',
        'MALFORMED_RESPONSE',
        error.failure.requestId === undefined ? undefined : { requestId: error.failure.requestId },
      )
    }
    throw error
  }
}
/**
 * Register the account catalog without a second model engine or ambient provider credentials.
 * @param ctx - plugin context with account and LLM services.
 * @param config - public deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const deployment = deploymentOf(config)
  const adapter = new VerbooAdapter(ctx, deployment)
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'Verboo Code',
      settingsNs: ctx.fiber.entry?.options.id ?? 'verboo-account',
      settingsPath: [],
    },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
