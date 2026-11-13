/**
 * The route composes over the installed Codex catalog: it offers the GPT
 * models only while a session is stored, classifies a subscription refusal
 * into the harness quota codes, and reads usage without ever throwing.
 */
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenAiAccountAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import { CATALOG_PROVIDER } from '../src/index.ts'
import OpenAiAccountRoute from '../src/index.ts'
import type { OpenAiAccountService } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

/** A JWT-shaped fixture access token carrying the account claim the backend reads. */
function accessTokenFor(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.signature`
}

/** A stored session double: one token and its account, no provider call. */
function session(options: { accountId?: string; signedOut?: boolean; throws?: boolean } = {}): OpenAiAccountService {
  const accountId = options.accountId ?? 'acct-1'
  return {
    accessToken: async () => {
      if (options.throws === true) throw new Error('refresh rejected')
      return options.signedOut === true ? undefined : accessTokenFor(accountId)
    },
    status: async () => ({
      signedIn: options.signedOut !== true,
      accountId,
      planType: 'plus',
    }),
  }
}

/** Mount the shared runtime and this route with an optional stored session. */
async function harness(stored: OpenAiAccountService | undefined): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  if (stored !== undefined) ctx.provide('openaiAccount', stored)
  await ctx.plugin(OpenAiAccountRoute)
  return ctx
}

/** Drive one streamed request through the runtime and return its terminal reason. */
async function finishOf(ctx: Context, options: Partial<GenerateOptions> = {}) {
  const assembler = new BlockAssembler()
  const request = { provider: 'openai-account', model: 'gpt-5.5', messages: [], ...options }
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
  return assembler.finish
}

/** Answer every request with one status and body, recording what was sent. */
function backend(status: number, body: unknown, headers: Record<string, string> = {}) {
  const requests: Array<{ url: string; headers: Headers }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push({ url: url.href, headers: new Headers(init?.headers) })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  })
  return requests
}

/** The reading the route's Remote method returns, or `undefined`. */
async function readingOf(ctx: Context, signal = new AbortController().signal) {
  return ctx.get('llmOpenaiAccount')?.usage(signal)
}

it('registers the openai-account route under a ChatGPT product name', async () => {
  const profiles = resolveProfiles({ [CATALOG_PROVIDER]: { displayName: 'ChatGPT' } })
  const adapter = new OpenAiAccountAdapter({ profiles: () => profiles, accessToken: async () => undefined })
  expect(adapter.providerInfo('openai-account')).toEqual({ id: 'openai-account', name: 'ChatGPT' })
  const ctx = await harness(session())
  expect(ctx.get('llmOpenaiAccount')).toBeDefined()
})

it('offers no model while no session is stored', async () => {
  const ctx = await harness(undefined)
  expect(await ctx.llm.listModels('openai-account')).toEqual([])
})

it('offers no model while the stored session reports no token', async () => {
  const ctx = await harness(session({ signedOut: true }))
  expect(await ctx.llm.listModels('openai-account')).toEqual([])
})

it('offers no model while the stored session cannot produce a token', async () => {
  const ctx = await harness(session({ throws: true }))
  expect(await ctx.llm.listModels('openai-account')).toEqual([])
})

it('offers the installed GPT models under this route while a session is stored', async () => {
  const ctx = await harness(session())
  const models = await ctx.llm.listModels('openai-account')
  expect(models.length).toBeGreaterThan(0)
  expect(models.map(model => model.provider)).toEqual(models.map(() => 'openai-account'))
  expect(models.map(model => model.id)).toContain('gpt-5.5')
})

it('fails a request with a typed sign-in error when no token is available', async () => {
  const ctx = await harness(session({ signedOut: true }))
  await expect(finishOf(ctx)).resolves.toMatchObject({
    kind: 'error',
    failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED' },
  })
})

it('authenticates the request with the account token and account id', async () => {
  const requests = backend(429, { error: { message: 'rate limit reached, please retry' } })
  const ctx = await harness(session({ accountId: 'acct-7' }))
  await finishOf(ctx)
  expect(requests[0]?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
  expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${accessTokenFor('acct-7')}`)
  expect(requests[0]?.headers.get('chatgpt-account-id')).toBe('acct-7')
})

it('reports a workspace usage limit as a non-retryable QUOTA failure', async () => {
  // The Codex transport renders every 429 as its own sentence and keeps the
  // reset hint the backend supplied, which is what identifies a spent window.
  backend(429, {
    error: { code: 'usage_limit_reached', message: 'limit reached', plan_type: 'plus', resets_at: Math.floor(Date.now() / 1000) + 600 },
  })
  const ctx = await harness(session())
  const finish = await finishOf(ctx)
  expect(finish).toMatchObject({ kind: 'error', failure: { code: 'QUOTA' } })
  expect(finish.kind === 'error' ? finish.failure.message : '').not.toContain('super-secret')
})

it('reports depleted credits as ACCOUNT_QUOTA', async () => {
  backend(402, { error: { code: 'insufficient_quota', message: 'Your credits are depleted.' } })
  const ctx = await harness(session())
  await expect(finishOf(ctx)).resolves.toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_QUOTA' } })
})

it('keeps a transient 429 retryable as RATE_LIMIT', async () => {
  backend(429, { error: { message: 'rate limit reached, please retry' } })
  const ctx = await harness(session())
  await expect(finishOf(ctx)).resolves.toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT' } })
})

it('reads usage through the Remote method', async () => {
  backend(200, {
    plan_type: 'plus',
    rate_limit: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 600 },
  }, { 'x-codex-credits-unlimited': 'true' })
  const ctx = await harness(session())
  await expect(readingOf(ctx)).resolves.toMatchObject({
    usedPercent: 12,
    windowSeconds: 18_000,
    resetAfterSeconds: 600,
    unlimited: true,
    planType: 'plus',
  })
})

it('reports no usage reading when no session is stored', async () => {
  const ctx = await harness(undefined)
  await expect(readingOf(ctx)).resolves.toBeUndefined()
})

it('reports no usage reading when the read fails, never zero', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
  const ctx = await harness(session())
  await expect(readingOf(ctx)).resolves.toBeUndefined()
})

it('reports no usage reading when the body carries no window', async () => {
  backend(200, { plan_type: 'plus' })
  const ctx = await harness(session())
  await expect(readingOf(ctx)).resolves.toBeUndefined()
})

it('keeps the token out of a failure message', async () => {
  backend(500, { error: { message: 'boom' } })
  const ctx = await harness(session())
  const finish = await finishOf(ctx)
  expect(JSON.stringify(finish)).not.toContain(accessTokenFor('acct-1'))
})

it('withdraws the route when the plugin disposes', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.provide('openaiAccount', session())
  const route = ctx.plugin(OpenAiAccountRoute)
  await route
  await route.dispose()
  expect(ctx.get('llmOpenaiAccount')).toBeUndefined()
  await expect(ctx.llm.listModels('openai-account')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
})

it('refuses an image request when no attachment service is mounted', async () => {
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
  const ctx = await harness(session())
  await expect(finishOf(ctx, {
    messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }], source: { kind: 'test' } } as never],
  })).resolves.toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_CONTENT' } })
})

it('reports no usage reading when the session is signed out', async () => {
  const ctx = await harness(session({ signedOut: true }))
  await expect(readingOf(ctx)).resolves.toBeUndefined()
})

it('reports no usage reading when the session read fails', async () => {
  const ctx = await harness(session({ throws: true }))
  await expect(readingOf(ctx)).resolves.toBeUndefined()
})

it('reads usage without an account identifier when the session reports none', async () => {
  const requests: Array<Headers> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    requests.push(new Headers(init?.headers))
    return new Response(JSON.stringify({ used_percent: 3 }), { status: 200 })
  })
  const stored: OpenAiAccountService = {
    accessToken: async () => {
      const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
      return `${encode({})}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-token' } })}.sig`
    },
    status: async () => ({ signedIn: true }),
  }
  const ctx = await harness(stored)
  await expect(readingOf(ctx)).resolves.toMatchObject({ usedPercent: 3 })
  expect(requests[0]?.get('chatgpt-account-id')).toBe('acct-token')
})
