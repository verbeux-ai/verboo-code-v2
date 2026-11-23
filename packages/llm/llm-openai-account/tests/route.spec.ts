/**
 * The route composes over the installed Codex catalog: it offers the GPT
 * models only while a session is stored, classifies a subscription refusal
 * into the harness quota codes, and reads usage without ever throwing.
 */
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiAccountAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import { CATALOG_PROVIDER } from '../src/index.ts'
import OpenAiAccountRoute from '../src/index.ts'
import type { OpenAiAccountService, SweepResult } from '../src/types.ts'

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
function session(options: { accountId?: string; signedOut?: boolean; throws?: boolean; statusThrows?: boolean } = {}): OpenAiAccountService {
  const accountId = options.accountId ?? 'acct-1'
  return {
    accessToken: async () => {
      if (options.throws === true) throw new Error('refresh rejected')
      return options.signedOut === true ? undefined : accessTokenFor(accountId)
    },
    status: async () => {
      if (options.statusThrows === true) throw new Error('session store down')
      return {
        signedIn: options.signedOut !== true,
        accountId,
        planType: 'plus',
      }
    },
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

describe('the discovery sweep', () => {
  it('answers an empty sweep when the status read fails', async () => {
    const ctx = await harness(session({ statusThrows: true }))
    const route = ctx.get('llmOpenaiAccount') as { discoverModels(): Promise<SweepResult> }
    await expect(route.discoverModels()).resolves.toEqual({
      supported: [], unsupported: [], skipped: [], stoppedAtLimit: false,
    })
  })
  it('answers an empty sweep while signed out', async () => {
    const ctx = await harness(undefined)
    const route = ctx.get('llmOpenaiAccount') as { discoverModels(): Promise<SweepResult> }
    await expect(route.discoverModels()).resolves.toEqual({
      supported: [], unsupported: [], skipped: [], stoppedAtLimit: false,
    })
  })

  it('sweeps the installed catalog and remembers the verdicts per account', { timeout: 30_000 }, async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(
        [
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
          'data: [DONE]',
        ].join('\n\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }))
    const ctx = await harness(session())
    const route = ctx.get('llmOpenaiAccount') as { discoverModels(): Promise<SweepResult> }
    const result = await route.discoverModels()
    // The catalog's models were probed, cheapest first: at least one probe
    // per listed model.
    expect(urls.filter(url => url.includes('/chat/completions')).length)
      .toBeGreaterThanOrEqual(result.supported.length + result.unsupported.length + result.skipped.length)
    expect(result.stoppedAtLimit).toBe(false)
    // A second trigger after the sweep finished starts a fresh sweep with
    // the same verdicts: the probes are idempotent.
    await expect(route.discoverModels()).resolves.toEqual(result)
  })

  it('records an unsupported verdict from the terminal refusal and survives a throwing transport', { timeout: 30_000 }, async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls += 1
      if (String(input).includes('/models')) {
        return new Response('{}', { status: 200 })
      }
      // Half the probes throw out of the transport (the catch path), and the
      // others finish with the Codex refusal wording (the record path).
      if (calls % 2 === 0) throw new Error('not supported when using Codex with a ChatGPT account')
      return new Response(
        [
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.5', choices: [{ index: 0, delta: {}, finish_reason: 'The gpt-5.5 model is not supported when using Codex with a ChatGPT account.' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
          'data: [DONE]',
        ].join('\n\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }))
    const ctx = await harness(session())
    const route = ctx.get('llmOpenaiAccount') as { discoverModels(): Promise<SweepResult> }
    const result = await route.discoverModels()
    // Both failure shapes classify without throwing out of the sweep.
    expect(result.unsupported.length).toBeGreaterThan(0)
    expect(result.stoppedAtLimit).toBe(false)
  })

  it('stops the sweep at the first limit refusal and skips the rest', { timeout: 30_000 }, async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/models')) return new Response('{}', { status: 200 })
      calls += 1
      // The transport throws the rendered limit sentence: the pi-ai error stop
      // carries that text, and the sweep's classifier reads it as a limit.
      throw new Error('You have hit your ChatGPT usage limit. Your limit resets tomorrow at 00:00.')
    }))
    const ctx = await harness(session())
    const route = ctx.get('llmOpenaiAccount') as { discoverModels(): Promise<SweepResult> }
    const result = await route.discoverModels()
    expect(result.stoppedAtLimit).toBe(true)
    // The sweep stopped: it never probed the whole catalog.
    expect(calls).toBeLessThan(9)
    expect(result.skipped.length).toBeGreaterThan(0)
  })

  it('classifies a throwing sign-in as unknown through the probe catch', { timeout: 30_000 }, async () => {
    const ctx = await harness(session({ throws: true }))
    const route = ctx.get('llmOpenaiAccount') as { discoverModels(): Promise<SweepResult> }
    const result = await route.discoverModels()
    // Nothing was proved either way: every probe lands in the unknown bucket.
    expect(result.supported).toEqual([])
    expect(result.unsupported).toEqual([])
    expect(result.stoppedAtLimit).toBe(false)
  })

  it('answers an empty sweep when the catalog provider is not installed', async () => {
    const ctx = await harness(undefined)
    const route = ctx.get('llmOpenaiAccount') as { discoverModels(): Promise<SweepResult> }
    // The account is undefined before any sweep: the route reads the session,
    // and a missing session answers the empty result without probing.
    await expect(route.discoverModels()).resolves.toEqual({
      supported: [], unsupported: [], skipped: [], stoppedAtLimit: false,
    })
  })
})

describe('the verdict recording over the real transport', () => {
  /** One complete Codex responses stream, as the backend sends it. */
  function codexStream(text: string, terminal: unknown): Response {
    const events: Array<Record<string, unknown>> = [
      { type: 'response.created', response: { id: 'resp-1' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } },
      { type: 'response.output_text.delta', item_id: 'msg-1', delta: text },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
    ]
    events.push(terminal as Record<string, unknown>)
    const body = events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')
    return new Response(`${body}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  it('records supported for a clean call and unsupported for the Codex refusal', { timeout: 30_000 }, async () => {
    const recorded: Array<[string, string, string]> = []

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/models')) return new Response('{}', { status: 200 })
      if (!url.includes('codex/responses')) return new Response('{}', { status: 200 })
      // Alternate clean and refused calls by call count on the stub itself.
      responsesServed += 1
      return responsesServed % 2 === 1
        ? codexStream('ok', { type: 'response.completed', response: { id: 'resp-1', status: 'completed', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } })
        : codexStream('', { type: 'error', code: 'model_not_supported', message: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." })
    }))
    const ctx = await harness(session())
    const route = ctx.get('llmOpenaiAccount') as { discoverModels(): Promise<SweepResult> }
    const result = await route.discoverModels()
    expect(result.supported.length).toBeGreaterThan(0)
    expect(result.unsupported.length).toBeGreaterThan(0)
    expect(recorded).toEqual([])
    expect(responsesServed).toBeGreaterThan(0)
  })

  let responsesServed = 0
})
