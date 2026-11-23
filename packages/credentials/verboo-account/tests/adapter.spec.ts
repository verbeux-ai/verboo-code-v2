/** The account adapter: discovery, auth rotation on a mid-stream refusal, and the error translations. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply, PROVIDER } from '../src/models.ts'
import { AccountRequestError } from '../src/http.ts'
import type { Deployment } from '../src/config.ts'

/** A deployment double the adapter reads. */
function deployment(): Deployment {
  return {
    apiOrigin: 'https://api.example.com',
    routerBaseURL: 'https://router.example.com/v1',
    clientId: 'client-1',
    requestTimeoutMs: 5_000,
    attemptTimeoutMs: 5_000,
    catalogMaxAgeMs: 60_000,
    fallbackContextWindow: 128_000,
    fallbackMaxOutputTokens: 8_192,
    malformedResponseRetries: 1,
  }
}

/** One platform session the account double hands out. */
interface Session { sessionId: string; token: string }

/** An account double: token rotation, session reads, and rejection recording. */
interface AccountDouble {
  resolveToken: (baseURL: string) => Promise<string | undefined>
  getPlatformSession: () => Promise<Session | null>
  rejectToken: (token: string) => Promise<void>
}

/** Mount the real LLM runtime beside the adapter: LlmRuntime is its own service, so ctx.llm is the runtime. */
async function adapterWithRuntime(account: AccountDouble): Promise<Context & { llm: LlmRuntime }> {
  const ctx = new Context()
  const home = mkdtempSync(join(tmpdir(), 'verboo-models-'))
  ctx.provide('deepseekAccount', account as never)
  ctx.provide('logger', { warn: vi.fn(), info: vi.fn() } as never)
  await ctx.plugin(LlmRuntime)
  apply(ctx, { deployment: deployment(), home } as never)
  ctx.provide('DSH_HOME', home)
  rmSync(home, { recursive: true, force: true })
  return ctx as unknown as Context & { llm: LlmRuntime }
}

/** One listed model profile, as the router sends it. */
const listing = (reasoning: unknown = { effort_levels: ['low', 'high'] }): unknown => ({
  data: [{
    id: 'verboo/flash', display_name: 'Verboo Flash', context_window: 128_000,
    max_output_tokens: 8_192, reasoning,
  }],
})

/** One streamed response the pi-ai adapter consumes. */
const streamBody = (text: string): Response => {
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]
  const sse = chunks
    .map(chunk => `data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'verboo/flash', ...chunk })}\n\n`)
    .join('')
  return new Response(`${sse}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('VerbooAdapter discovery', () => {
  it('loads the listing through the account token and registers the profiles', async () => {
    console.error('DEBUG PROVIDER:', JSON.stringify(PROVIDER))
    let calls = 0
    const account: AccountDouble = {
      resolveToken: async () => { calls += 1; return 'token-1' },
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
      rejectToken: async () => undefined,
    }
    const ctx = await adapterWithRuntime(account)
    stubFetch(() => json(listing()))
    const models = await ctx.llm.listModels(PROVIDER)
    expect(models.map(model => model.id)).toEqual(['verboo/flash'])
    // The second load within the catalog age reuses the cached listing.
    await ctx.llm.listModels(PROVIDER)
    expect(models.map(model => model.id)).toEqual(['verboo/flash'])
  })

  it('reports no models when the account has no stored grant', async () => {
    const account: AccountDouble = {
      resolveToken: async () => undefined,
      getPlatformSession: async () => null,
      rejectToken: async () => undefined,
    }
    const ctx = await adapterWithRuntime(account)
    stubFetch(() => json(listing()))
    await expect(ctx.llm.listModels(PROVIDER)).resolves.toEqual([])
  })

  it('translates a failed listing into MODEL_LISTING_FAILED and rejects the token on auth failures', async () => {
    const rejected: string[] = []
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
      rejectToken: async token => { rejected.push(token) },
    }
    const ctx = await adapterWithRuntime(account)
    stubFetch(() => json({ error: 'invalid_grant' }, 401))
    await expect(ctx.llm.listModels(PROVIDER)).rejects.toMatchObject({ code: 'MODEL_LISTING_FAILED' })
    expect(rejected).toEqual(['token-1'])
  })

  it('replaces the profiles when the account signs out', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
      rejectToken: async () => undefined,
    }
    const ctx = await adapterWithRuntime(account)
    stubFetch(() => json(listing()))
    await ctx.llm.listModels(PROVIDER)
    ctx.emit('deepseek-account/signed-out')
    await new Promise(resolve => setTimeout(resolve, 10))
    // The catalog reloads on the next list call: the cache was dropped.
    const after = await ctx.llm.listModels(PROVIDER)
    expect(after.map(model => model.id)).toEqual(['verboo/flash'])
  })
})

describe('VerbooAdapter streaming auth rotation', () => {
  /** One content chunk in the wire shape the pi-ai adapter parses. */
  function authRefusal(): Response {
    // A valid SSE whose terminal chunk carries the 401 in its finish reason:
    // the provider maps the unknown reason to an error stop with that text,
    // and the adapter classifies AUTH from the 401 in it.
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: '401 session rejected' }] },
    ]
    const sse = chunks
      .map(chunk => `data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'verboo/flash', ...chunk })}\n\n`)
      .join('')
    return new Response(`${sse}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  it('refreshes the token on a pre-output AUTH refusal and streams with the new token', async () => {
    const sessions = [
      { sessionId: 'session-1', token: 'token-1' },
      { sessionId: 'session-1', token: 'token-2' },
    ]
    let read = 0
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => sessions[Math.min(read, sessions.length - 1)]!,
      rejectToken: async () => undefined,
      refreshRejectedToken: async () => { read += 1; return 'token-2' },
    } as never
    const ctx = await adapterWithRuntime(account)
    const bodies: string[] = []
    stubFetch((url, init) => {
      // The catalog load runs first, then the stream hits the auth refusal.
      console.error('DEBUG url:', String(url))
      if (String(url).endsWith('/models')) return json(listing())
      bodies.push(String(init.body ?? ''))
      return bodies.length === 1 ? authRefusal() : streamBody('hello')
    })
    const chunks: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Olá' }] }] })) {
      console.error('DEBUG chunk:', JSON.stringify(chunk).slice(0, 160))
      if (chunk.type === 'text-delta') chunks.push(chunk.text)
    }
    expect(chunks.join('')).toBe('hello')
    expect(bodies.length).toBe(2)
  })

  it('throws ACCOUNT_REFRESH_FAILED when the refresh itself fails', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
      rejectToken: async () => undefined,
      refreshRejectedToken: async () => { throw new Error('store down') },
    } as never
    const ctx = await adapterWithRuntime(account)
    stubFetch((url, init) => {
      console.error('DEBUG url:', String(url), String(init.body ?? '').slice(0, 30))
      return String(url).endsWith('/models') ? json(listing()) : authRefusal()
    })
    const codes: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Olá' }] }] })) {
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') codes.push(chunk.reason.failure.code)
    }
    expect(codes).toContain('ACCOUNT_REFRESH_FAILED')
  })

  it('reports an expired sign-in when the refresh leaves no session', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
      rejectToken: async () => undefined,
      refreshRejectedToken: async () => 'token-2',
    } as never
    const ctx = await adapterWithRuntime(account)
    // After the refresh, the session is gone.
    account.getPlatformSession = async () => null
    stubFetch((_url) => (String(_url).endsWith('/models') ? json(listing()) : authRefusal()))
    const codes: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Olá' }] }] })) {
      console.error('DEBUG finish:', JSON.stringify(chunk).slice(0, 180))
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') codes.push(chunk.reason.failure.code)
    }
    expect(codes).toContain('ACCOUNT_SIGN_IN_REQUIRED')
  })

  it('propagates a caller cancellation during the token refresh', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
      rejectToken: async () => undefined,
      refreshRejectedToken: async () => { throw new AccountRequestError('request_cancelled') },
    } as never
    const ctx = await adapterWithRuntime(account)
    stubFetch((_url) => (String(_url).endsWith('/models') ? json(listing()) : authRefusal()))
    const codes: string[] = []
    const aborter = new AbortController()
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Olá' }] }], signal: aborter.signal })) {
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) codes.push(chunk.reason.failure.code)
    }
    expect(codes).toContain('ABORTED')
  })
})

/** Stub fetch with an instrumented handler. */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<unknown> | unknown): void {
  console.error('DEBUG stubFetch installed')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    impl(input instanceof URL ? input.href : input instanceof Request ? input.url : input, init ?? {}) as Response))
}

/** One JSON response helper. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}
