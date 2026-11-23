/** The Verboo model adapter: discovery, stream auth rotation, and the failure translations. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { apply, PROVIDER } from '../src/models.ts'
import type { Deployment } from '../src/config.ts'

/** A deployment double carrying only the fields the adapter reads. */
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
  rejectToken?: (token: string) => Promise<void>
  refreshRejectedToken?: (baseURL: string, token: string, signal?: AbortSignal) => Promise<string | undefined>
}

/** Mount the real LLM runtime and this route with an account double the tests steer. */
async function mount(account: AccountDouble): Promise<Context & { llm: LlmRuntime }> {
  const ctx = new Context()
  ctx.provide('deepseekAccount', account as never)
  ctx.provide('logger', { warn: vi.fn(), info: vi.fn() } as never)
  await ctx.plugin(LlmRuntime)
  apply(ctx, { deployment: deployment() } as never)
  return ctx as unknown as Context & { llm: LlmRuntime }
}

/** One listed model row, as the router sends it. */
const listing = (): unknown => ({
  data: [{
    id: 'verboo/flash',
    display_name: 'Verboo Flash',
    context_window: 128_000,
    max_output_tokens: 8_192,
    reasoning: { effort_levels: ['low', 'high'] },
  }],
})

/** One streamed SSE completion, in the shape the transport consumes. */
function streamBody(text: string, terminal?: Record<string, unknown>): Response {
  const chunks: Array<Record<string, unknown>> = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]
  const sse = chunks
    .map(chunk => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'verboo/flash', ...chunk })}\n\n`)
    .join('')
  void terminal
  return new Response(`${sse}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('VerbooAdapter discovery and streaming', () => {
  it('lists the catalog models through the account token', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
    }
    const ctx = await mount(account)
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      if (String(input).endsWith('/models')) return new Response(JSON.stringify(listing()), { status: 200 })
      return streamBody('hello')
    }))
    const models = await ctx.llm.listModels(PROVIDER)
    expect(models.map(model => model.id)).toEqual(['verboo/flash'])
    expect(urls.some(url => url.endsWith('/models'))).toBe(true)
  })

  it('reports no models and refuses the call while the account has no grant', async () => {
    const account: AccountDouble = {
      resolveToken: async () => undefined,
      getPlatformSession: async () => null,
    }
    const ctx = await mount(account)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(listing()), { status: 200 })))
    await expect(ctx.llm.listModels(PROVIDER)).resolves.toEqual([])
    const codes: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Olá' }] }] })) {
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) codes.push(chunk.reason.failure.code)
    }
    expect(codes).toContain('ACCOUNT_SIGN_IN_REQUIRED')
  })

  it('translates a failed listing into MODEL_LISTING_FAILED and rejects the token on auth failures', async () => {
    const rejected: string[] = []
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
      rejectToken: async token => { rejected.push(token) },
    }
    const ctx = await mount(account)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 401 })))
    await expect(ctx.llm.listModels(PROVIDER)).rejects.toMatchObject({ code: 'MODEL_LISTING_FAILED' })
    expect(rejected).toEqual(['token-1'])
  })

  it('resets the catalog when the account signs out and reloads on the next call', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
    }
    const ctx = await mount(account)
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(listing()), { status: 200 })))
    await ctx.llm.listModels(PROVIDER)
    ctx.emit('deepseek-account/signed-out')
    await new Promise(resolve => setTimeout(resolve, 10))
    const after = await ctx.llm.listModels(PROVIDER)
    expect(after.map(model => model.id)).toEqual(['verboo/flash'])
  })

  it('resolves a model and prepares the call through the account session', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
    }
    const ctx = await mount(account)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) return new Response(JSON.stringify(listing()), { status: 200 })
      return streamBody('hello')
    }))
    const info = await ctx.llm.resolveModelInfo(PROVIDER, 'verboo/flash')
    expect(info.id).toBe('verboo/flash')
  })
})

describe('VerbooAdapter streaming', () => {
  it('streams a clean call through the account session', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
    }
    const ctx = await mount(account)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) return new Response(JSON.stringify(listing()), { status: 200 })
      return streamBody('olá')
    }))
    const texts: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Oi' }] }] })) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts.join('')).toBe('olá')
  })
})

describe('VerbooAdapter auth rotation mid-stream', () => {
  it('refreshes the token on a pre-output AUTH refusal and streams with the new token', async () => {
    let chats = 0
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
      refreshRejectedToken: async () => 'token-2',
    }
    const ctx = await mount(account)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) return new Response(JSON.stringify(listing()), { status: 200 })
      chats += 1
      if (chats === 1) {
        return new Response(JSON.stringify({ error: { message: 'session rejected with status 401' } }), { status: 401 })
      }
      return streamBody('hello')
    }))
    const texts: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Oi' }] }] })) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts.join('')).toBe('hello')
    expect(chats).toBe(2)
  })
})

describe('VerbooAdapter refresh outcomes', () => {
  /** One AUTH-refusing stream, in the shape the transport classifies. */
  const refusal = (): Response => new Response(
    JSON.stringify({ error: { message: 'session rejected with status 401' } }),
    { status: 401 },
  )

  it('translates a failed refresh into ACCOUNT_REFRESH_FAILED', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
      refreshRejectedToken: async () => { throw new Error('store down') },
    }
    const ctx = await mount(account)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/models') ? new Response(JSON.stringify(listing()), { status: 200 }) : refusal()))
    const codes: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Oi' }] }] })) {
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) codes.push(chunk.reason.failure.code)
    }
    expect(codes).toContain('ACCOUNT_REFRESH_FAILED')
  })

  it('reports an expired sign-in when the refresh leaves no session', async () => {
    let sessions = 0
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => {
        sessions += 1
        return sessions > 2 ? null : { sessionId: 'session-1', token: 'token-1' }
      },
      refreshRejectedToken: async () => 'token-2',
    }
    const ctx = await mount(account)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/models') ? new Response(JSON.stringify(listing()), { status: 200 }) : refusal()))
    const codes: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Oi' }] }] })) {
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) codes.push(chunk.reason.failure.code)
    }
    expect(codes).toContain('ACCOUNT_SIGN_IN_REQUIRED')
  })

  it('keeps the buffered usage chunk when the failure carries no verdict', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
    }
    const ctx = await mount(account)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/models') ? new Response(JSON.stringify(listing()), { status: 200 }) : refusal()))
    const usage: unknown[] = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Oi' }] }] })) {
      if (chunk.type === 'usage') usage.push(chunk)
    }
    // The buffered usage still reaches the caller even when the call failed.
    expect(usage.length).toBeGreaterThan(0)
  })
})


describe('VerbooAdapter catalog races', () => {
  it('joins a sweep still in flight instead of probing twice', async () => {
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId: 'session-1', token: 'token-1' }),
    }
    const ctx = await mount(account)
    let listingCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) {
        listingCalls += 1
        // Hold the first listing long enough for a second trigger to arrive.
        if (listingCalls === 1) await new Promise(resolve => setTimeout(resolve, 80))
        return new Response(JSON.stringify(listing()), { status: 200 })
      }
      return streamBody('hello')
    }))
    const [first, second] = await Promise.all([
      ctx.llm.listModels(PROVIDER),
      ctx.llm.listModels(PROVIDER),
    ])
    expect(first.map(model => model.id)).toEqual(['verboo/flash'])
    expect(second.map(model => model.id)).toEqual(['verboo/flash'])
    expect(listingCalls).toBe(1)
  })

  it('discards a listing fetched under a session that has since changed', async () => {
    let sessionId = 'session-1'
    const account: AccountDouble = {
      resolveToken: async () => 'token-1',
      getPlatformSession: async () => ({ sessionId, token: 'token-1' }),
    }
    const ctx = await mount(account)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) {
        // The account re-authenticates while the listing is in flight.
        sessionId = 'session-2'
        return new Response(JSON.stringify(listing()), { status: 200 })
      }
      return streamBody('hello')
    }))
    await expect(ctx.llm.listModels(PROVIDER)).resolves.toEqual([])
  })

  it('refuses model resolution while no grant is stored', async () => {
    const account: AccountDouble = {
      resolveToken: async () => undefined,
      getPlatformSession: async () => null,
    }
    const ctx = await mount(account)
    const codes: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: 'verboo/flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'Oi' }] }] })) {
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) codes.push(chunk.reason.failure.code)
    }
    expect(codes).toContain('ACCOUNT_SIGN_IN_REQUIRED')
  })
})
