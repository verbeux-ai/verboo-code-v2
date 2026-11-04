/** Account-bound OpenAI-compatible model discovery using the existing pi-ai transport. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { z } from 'zod'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {
  LlmModelInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  GenerateOptions,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-deepseek-account'
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
          reasoning: z
            .union([z.boolean(), z.object({}).loose()])
            .optional(),
        })
        .loose(),
    )
    .max(2000),
})

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
    }
  })
}

/** The shared transport with discovery and each prepared request bound to one account credential. */
class VerbooAdapter extends PiAiAdapter {
  private loaded: { sessionId: string; at: number } | undefined
  private pending: { sessionId: string; work: Promise<boolean> } | undefined
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
      auth: {
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
      },
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) =>
        resolveImageAttachmentAccess(attachments, () => undefined, ref),
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
    const sessionId = (await this.ctx.deepseekAccount.getPlatformSession())
      ?.sessionId
    if (sessionId === undefined) return false
    if (
      this.loaded?.sessionId === sessionId &&
      Date.now() - this.loaded.at < this.deployment.catalogMaxAgeMs
    )
      return true
    if (this.pending?.sessionId === sessionId) return this.pending.work
    if (this.loaded?.sessionId !== sessionId) {
      this.loaded = undefined
      this.replace([])
    }
    const context = operation()
    const pending = {
      sessionId,
      work: Promise.resolve()
        .then(async () => {
          observe(context, 'catalog', 'started')
          try {
            const response = await new VerbooHttp(this.deployment).request(
              `${this.deployment.routerBaseURL}/models`,
              {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.any([
                  this.lifetime.signal,
                  this.generation.signal,
                  ...(signal ? [signal] : []),
                ]),
              },
              context,
            )
            const models = parseModels(response, this.deployment)
            if (
              (await this.ctx.deepseekAccount.getPlatformSession())
                ?.sessionId !== sessionId
            ) {
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
      stream: options => this.observeAuthentication(prepared.stream(options)),
    }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!(await this.load(options.signal)))
      throw new LlmError(
        'Entre na sua conta Verboo para continuar.',
        'ACCOUNT_SIGN_IN_REQUIRED',
      )
    yield* this.observeAuthentication(super.stream(options))
  }

  private async *observeAuthentication(
    stream: AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const session = await this.ctx.deepseekAccount.getPlatformSession()
    for await (const chunk of stream) {
      // The shared SDK groups 401 and 403 as AUTH. Only the account server can
      // establish that the grant itself expired; an entitlement failure cannot.
      if (
        chunk.type === 'finish' &&
        chunk.reason.kind === 'error' &&
        chunk.reason.failure.code === 'AUTH' &&
        session?.sessionId ===
          (await this.ctx.deepseekAccount.getPlatformSession())?.sessionId
      ) {
        await this.ctx.deepseekAccount.getProfile({
          locale: 'en',
          version: '0.2.2-alpha.3',
          timezoneOffsetSeconds: 0,
        })
      }
      yield chunk
    }
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
