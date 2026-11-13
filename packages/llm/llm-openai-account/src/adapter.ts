/**
 * The `openai-account` route: a thin composition over the pi-ai adapter that
 * serves the installed `openai-codex` catalog (GPT models over the
 * `openai-codex-responses` protocol at the ChatGPT backend) under this
 * plugin's own route key, and rewrites a subscription refusal into the harness
 * provider-neutral quota codes.
 *
 * Composition rather than a second transport: the pi-ai adapter already owns
 * the protocol, the transcript projection, replay state, and the streaming
 * vocabulary, and the installed catalog already owns the model list and
 * capacities. This adapter translates the route key, supplies the account
 * access token per request, and classifies the one failure this subscription
 * adds to the provider-neutral taxonomy.
 *
 * @module @deepseek-ai/dsh-llm-openai-account/adapter
 */

import type { AuthContext, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { CATALOG_PROVIDER } from './config.ts'
import { ACCOUNT_QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { classifyLimit } from './limits.ts'

/** Display name this route reports to selectors and status surfaces. */
export const DISPLAY_NAME = 'ChatGPT'

/** User-visible refusal when no stored account session can serve a request. */
export const SIGN_IN_MESSAGE = 'Sign in to your [OI] account to use the ChatGPT models.'
/** User-visible refusal when the plan's usage window is spent. */
export const USAGE_LIMIT_MESSAGE = 'The ChatGPT plan usage limit for this account is reached; requests resume when the current limit window resets.'
/** User-visible refusal when the account's credits are depleted. */
export const CREDITS_MESSAGE = 'The ChatGPT credits for this account are depleted; requests resume after the credits are replenished.'

/**
 * The harness credential plane pi-ai reads when a request carries no explicit
 * key. This route always passes the account access token as the request key,
 * so this store never holds anything: it exists because a pi-ai collection
 * requires one, and answering "nothing stored" keeps the account plugin the
 * single owner of the session.
 */
const NO_CREDENTIALS: CredentialStore = {
  read: (): Promise<Credential | undefined> => Promise.resolve(undefined),
  list: (): Promise<readonly CredentialInfo[]> => Promise.resolve([]),
  modify: (): Promise<Credential | undefined> => Promise.resolve(undefined),
  delete: (): Promise<void> => Promise.resolve(),
}

/** Ambient lookups a pi-ai provider performs while resolving its own auth. */
const NO_AMBIENT_AUTH: AuthContext = {
  env: (): Promise<string | undefined> => Promise.resolve(undefined),
  fileExists: (): Promise<boolean> => Promise.resolve(false),
}

/** Construction inputs the plugin owns. */
export interface OpenAiAccountAdapterOptions {
  /**
   * The resolved pi-ai profiles this route serves. The plugin builds them from
   * the installed Codex catalog and memoizes them, so an unchanged
   * configuration is recognized by identity.
   * @returns the profile map keyed by {@link CATALOG_PROVIDER}.
   */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the account access token for one request. Called once per stream
   * call and frozen for that call.
   * @returns the bearer token, or `undefined` while no session is usable.
   */
  accessToken: () => Promise<string | undefined>
  /** Resolve the durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /** Observe one assistant history message degrading to provider-neutral conversion. */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/**
 * Rewrite a terminal failure the subscription refused into its quota code.
 * @param failure - the failure the pi-ai adapter produced.
 * @returns the same failure under `QUOTA` or `ACCOUNT_QUOTA`, or the failure unchanged.
 */
export function quotaFailure(failure: LlmFailure): LlmFailure {
  const code = classifyLimit({
    ...failure.status === undefined ? {} : { status: failure.status },
    message: failure.message,
  })
  if (code === undefined) return failure
  return {
    ...failure,
    code,
    message: code === ACCOUNT_QUOTA_EXCEEDED_CODE ? CREDITS_MESSAGE : USAGE_LIMIT_MESSAGE,
  }
}

/**
 * The `openai-account` route over the installed Codex catalog.
 *
 * One pi-ai adapter instance is built here and never registered on `ctx.llm`;
 * this class is the registered adapter, so the pi-ai adapter keeps serving
 * exactly one route and every call crosses one explicit translation.
 */
export class OpenAiAccountAdapter extends LlmAdapter {
  private readonly inner: PiAiAdapter

  constructor(private readonly options: OpenAiAccountAdapterOptions) {
    super()
    this.inner = new PiAiAdapter({
      profiles: options.profiles,
      resolveApiKey: () => this.resolveAccessToken(),
      auth: { credentials: NO_CREDENTIALS, authContext: NO_AMBIENT_AUTH },
      ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
      ...options.resolveImageAccess === undefined ? {} : { resolveImageAccess: options.resolveImageAccess },
      ...options.onReplayDegrade === undefined ? {} : { onReplayDegrade: options.onReplayDegrade },
    })
  }

  /**
   * Resolve the access token a request authenticates with.
   * @returns the bearer token.
   * @throws {LlmError} `ACCOUNT_SIGN_IN_REQUIRED` when no session is usable.
   */
  private async resolveAccessToken(): Promise<string> {
    const token = await this.options.accessToken()
    if (token === undefined || token.length === 0) throw new LlmError(SIGN_IN_MESSAGE, 'ACCOUNT_SIGN_IN_REQUIRED')
    return token
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: DISPLAY_NAME }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    // The subscription reports its own limits as terminal codes, so the
    // harness default (bounded transient retries) already matches it.
    return undefined
  }

  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef) {
    return this.inner.imageRequestTarget(CATALOG_PROVIDER, model, image)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(async () => {
      // The catalog is the installed one, and a signed-out account can serve
      // none of it: an empty list is how this route reports unavailable.
      const token = await this.options.accessToken()
      if (token === undefined || token.length === 0) return []
      const profile = this.options.profiles().get(CATALOG_PROVIDER)
      const installed = profile?.piProvider
      if (installed === undefined) return []
      return installed.getModels().map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(async () => {
      const info = await this.inner.resolveModel(CATALOG_PROVIDER, model, signal)
      return { ...info, provider, id: model }
    })
  }

  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return Promise.resolve().then(async () => {
      const prepared = await this.inner.prepareCall(CATALOG_PROVIDER, model, signal)
      return {
        model: { ...prepared.model, provider, id: model },
        stream: options => this.translated(prepared.stream({ ...options, provider: CATALOG_PROVIDER, model })),
      }
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.translated(this.inner.stream({ ...options, provider: CATALOG_PROVIDER }))
  }

  /** Translate one inner stream, mapping a subscription refusal to its quota code. */
  private async * translated(chunks: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    try {
      for await (const chunk of chunks) {
        if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') {
          yield chunk
          continue
        }
        yield { ...chunk, reason: { kind: 'error', failure: quotaFailure(chunk.reason.failure) } }
      }
    } catch (error) {
      if (!(error instanceof LlmError)) throw error
      const failure = quotaFailure(error.failure)
      if (failure === error.failure) throw error
      throw new LlmError(failure.message, failure.code, { ...failure, cause: error })
    }
  }
}
