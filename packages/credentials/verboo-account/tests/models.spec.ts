/**
 * Model listing translation.
 *
 * The router advertises the reasoning levels it accepts. The selector's effort
 * pane renders only for a model that declares levels, so a listing that loses
 * them hides the control entirely on an account route.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import LlmRuntime, { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { DeepSeekAccount, PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountSessionId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import * as VerbooModels from '../src/models.ts'
import type { Deployment } from '../src/config.ts'
import { AccountRequestError } from '../src/http.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Conservative defaults a legacy listing without capability metadata receives. */
const deployment = {
  fallbackContextWindow: 128_000,
  fallbackMaxOutputTokens: 8_192,
} as Deployment

/**
 * Parse one listed row.
 * @param reasoning - the router's reasoning field for that row.
 * @returns the transport profile the adapter receives.
 */
function parse(reasoning: unknown) {
  return VerbooModels.parseModels({
    data: [{
      id: 'pro/deepseek-v4.1-flash',
      display_name: 'deepseek-v4.1-flash',
      context_window: 128_000,
      max_output_tokens: 8_192,
      reasoning,
    }],
  }, deployment)[0]!
}

describe('reasoning levels from the router', () => {
  it('maps every accepted level to its own wire spelling', () => {
    // Without this the profile carries only a flag, the adapter finds no
    // installed catalog entry for the id, and the model advertises no levels.
    const profile = parse({ effort_levels: ['low', 'medium', 'high', 'max'], default_effort: 'high' })
    expect(profile.reasoningEfforts).toEqual({ low: 'low', medium: 'medium', high: 'high', max: 'max' })
  })

  it('omits every level the router did not accept', () => {
    const profile = parse({ effort_levels: ['high'] })
    // The adapter refuses a null wire value for any level but `off`, and one
    // refusal fails the whole provider group. Absence marks unsupported.
    expect(profile.reasoningEfforts).toEqual({ high: 'high' })
  })

  it('accepts the camelCase spelling the router may use', () => {
    expect(parse({ effortLevels: ['high', 'max'] }).reasoningEfforts).toMatchObject({ high: 'high', max: 'max' })
  })

  it('matches a level whatever its case or surrounding space', () => {
    expect(parse({ effort_levels: [' HIGH ', 'Max'] }).reasoningEfforts).toMatchObject({ high: 'high', max: 'max' })
  })

  it('drops a level the adapter cannot spell rather than guessing a value', () => {
    const profile = parse({ effort_levels: ['turbo', 'high'] })
    expect(profile.reasoningEfforts).toEqual({ high: 'high' })
  })

  it('leaves the field absent when the router names no level', () => {
    // Absent keeps the installed catalog's capability; an empty dict would be
    // refused by the adapter as a model offering nothing.
    expect(parse(true).reasoningEfforts).toBeUndefined()
    expect(parse(undefined).reasoningEfforts).toBeUndefined()
    expect(parse({ effort_levels: [] }).reasoningEfforts).toBeUndefined()
    expect(parse({ effort_levels: ['turbo'] }).reasoningEfforts).toBeUndefined()
    // A declaration offering nothing beyond `off` is refused as well.
    expect(parse({ effort_levels: ['off'] }).reasoningEfforts).toBeUndefined()
  })

  it('declares no levels for a model the router flags without naming them', () => {
    // The adapter derives the capability itself; what the profile must not do is
    // claim a level set the router never listed.
    expect(parse(undefined).reasoningEfforts).toBeUndefined()
    expect(parse(true).reasoningEfforts).toBeUndefined()
  })
})

it('preserves compatible model identifiers and caps provider output at the context size', () => {
  const [model] = VerbooModels.parseModels({
    data: [{
      id: 'group/product-model', name: 'Product Model', context_length: 2048, max_tokens: 4096,
      vision: true, reasoning: { effortLevels: ['off', 'high'] },
    }],
  }, deployment)
  expect(model).toMatchObject({
    id: 'group/product-model', name: 'Product Model', contextWindow: 2048, maxTokens: 2048,
    input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' },
  })
})

it('rejects malformed or duplicated catalog identities', () => {
  expect(() => VerbooModels.parseModels({ data: 'invalid' }, deployment)).toThrow('contract_error')
  expect(() => VerbooModels.parseModels({ data: [{ id: 'same' }, { id: 'same' }] }, deployment)).toThrow('contract_error')
})

it('keeps account model authentication separate from ambient credentials', async () => {
  const auth = VerbooModels.verbooModelAuth()
  await expect(auth.credentials.list()).resolves.toEqual([])
  await expect(auth.credentials.read()).resolves.toBeUndefined()
  await expect(auth.credentials.delete()).resolves.toBeUndefined()
  await expect(auth.credentials.modify()).rejects.toMatchObject({ code: 'ACCOUNT_SIGN_IN_REQUIRED' })
  await expect(auth.authContext.env()).resolves.toBeUndefined()
  await expect(auth.authContext.fileExists()).resolves.toBe(false)
})

describe('a malformed capability hint never costs the listing', () => {
  it.each([
    ['null levels', { effort_levels: null }],
    ['numeric levels', { effort_levels: [1, 2] }],
    ['a bare string', { effort_levels: 'low' }],
    ['object levels', { effort_levels: [{ id: 'low' }] }],
    ['a numeric default', { default_effort: 3 }],
    ['an empty object', {}],
    ['a nested object', { reasoning: { effort_levels: ['low'] } }],
  ])('keeps every model when the router sends %s', (_case, reasoning) => {
    // A capability hint is optional decoration. Rejecting the response over it
    // leaves the account with no models at all, which is what a strict schema
    // here caused once already.
    expect(parse(reasoning)).toBeDefined()
  })

  it('still reads the levels from a well-formed object', () => {
    expect(parse({ effort_levels: ['low', 'high'] }).reasoningEfforts).toMatchObject({ low: 'low', high: 'high' })
  })
})

describe('a parsed listing survives the pi-ai adapter', () => {
  /**
   * Resolve one parsed profile through the real adapter.
   * @param reasoning - the router's reasoning field.
   * @returns the level ids the adapter serves, or the refusal it raised.
   */
  async function servedLevels(reasoning: unknown): Promise<readonly string[] | string> {
    const profile = parse(reasoning)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        account: {
          apiKeyEnv: 'ACCOUNT_TEST_KEY',
          api: 'openai-completions',
          baseURL: 'https://account.test/v1',
          models: [profile],
        },
      },
    })
    try {
      const info = await ctx.llm.resolveModelInfo('account', profile.id)
      return (info.reasoning?.efforts ?? []).map(effort => effort.id)
    } catch (error) {
      return (error as Error).message
    }
  }

  it('serves exactly the levels the router named', async () => {
    await expect(servedLevels({ effort_levels: ['low', 'medium', 'high', 'max'], default_effort: 'high' }))
      .resolves.toEqual(['low', 'medium', 'high', 'max'])
  })

  it('never pins an unoffered level to an empty wire value', async () => {
    // The adapter refuses a null wire value for every level but `off`, and one
    // refusal makes the whole provider group a failure, so the account loses
    // every model. Absence is how a level is marked unsupported.
    const served = await servedLevels({ effort_levels: ['low', 'high'] })
    expect(served).toEqual(['low', 'high'])
  })

  it('keeps a model whose router advertises only off', async () => {
    // A declaration with no thinking level is refused too, so this must fall
    // back to the installed capability rather than declare an unusable set.
    await expect(servedLevels({ effort_levels: ['off'] })).resolves.toEqual([])
  })

  it('keeps a model whose router named no level at all', async () => {
    await expect(servedLevels(true)).resolves.toEqual([])
  })
}, 30_000)

async function catalogFixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let session: PlatformSession = {
    origin: 'https://accounts.example.test', userId: null, sessionId: 'first-session' as AccountSessionId,
    token: 'first-fixture-token',
  }
  const account = {
    resolveToken: vi.fn<DeepSeekAccount['resolveToken']>(async () => session.token),
    getPlatformSession: vi.fn<DeepSeekAccount['getPlatformSession']>(async () => session),
    rejectToken: vi.fn<DeepSeekAccount['rejectToken']>(async () => {}),
    refreshRejectedToken: vi.fn<DeepSeekAccount['refreshRejectedToken']>(async () => undefined),
  }
  ctx.provide('deepseekAccount', account as unknown as DeepSeekAccount)
  await ctx.plugin(LlmRuntime)
  const register = vi.spyOn(ctx.llm, 'registerAdapter')
  await ctx.plugin({ name: VerbooModels.name, inject: VerbooModels.inject, apply: VerbooModels.apply }, {
    routerBaseURL: 'https://router.example.test/v1', apiOrigin: session.origin,
  })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({
    data: [{ id: 'current-group/current-model' }],
  }))
  vi.stubGlobal('fetch', fetch)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const adapter = register.mock.calls[0]?.[1]
  if (adapter === undefined) throw new Error('Verboo adapter was not registered')
  return {
    ctx, account, adapter, fetch,
    list: () => ctx.llm.listModels('deepseek-account'),
    setSession(sessionId: string, token: string) {
      session = { ...session, sessionId: sessionId as AccountSessionId, token }
    },
  }
}

function inferenceRequest(): GenerateOptions {
  return {
    provider: 'deepseek-account', model: 'current-group/current-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Confirm the fixture.' }] }],
  }
}

async function streamParts(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function refusedInference(): Response {
  return new Response('{"error":{"message":"fixture refusal"}}', {
    status: 401, headers: { 'content-type': 'application/json' },
  })
}

function completionWire(
  model: string, frames: readonly (readonly [object, string | null])[], responseId?: string,
): Response {
  const body = frames.map(([delta, finishReason]) => `data: ${JSON.stringify({
    ...responseId === undefined ? {} : { id: responseId },
    object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

it('uses normalized attachment bytes without exposing the host file path', async () => {
  const fixture = await catalogFixture()
  const request = inferenceRequest()
  fixture.fetch.mockResolvedValueOnce(Response.json({ data: [{ id: request.model, vision: true }] }))
  await fixture.list()
  const attachment = {
    attachmentId: brandString(`sha256:${'a'.repeat(64)}`),
    mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1,
  } satisfies Extract<GenerateOptions['messages'][number]['content'][number], { type: 'image' }>['attachment']
  const imageHostPath = vi.fn(() => '/fixture/private.png')
  const readImageRequest = vi.fn(async () => ({
    ...attachment, attachment, variantId: `sha256:${'b'.repeat(64)}`, data: Uint8Array.of(1),
    depth: 'uchar', space: 'srgb', hasAlpha: true,
  }))
  fixture.ctx.provide('attachments', { imageHostPath, readImageRequest } as never)
  fixture.fetch.mockResolvedValueOnce(completionWire(request.model, [
    [{ role: 'assistant', content: 'Confirmed' }, null], [{}, 'stop'],
  ], 'fixture-image-completion'))
  const chunks = await streamParts(fixture.adapter.stream({
    ...request, messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
  }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Confirmed' }))
  expect(imageHostPath).toHaveBeenCalledWith(attachment)
  expect(readImageRequest).toHaveBeenCalledOnce()
  const [input, init] = fixture.fetch.mock.calls.at(-1)!
  const body = await new Request(input, init).text()
  expect(body).toContain('data:image/png;base64,AQ==')
  expect(body).not.toContain('/fixture/private.png')
})

it('authenticates a direct adapter call and preserves the Router’s request identifier', async () => {
  const fixture = await catalogFixture()
  const request = inferenceRequest()
  const signal = new AbortController().signal
  await expect(fixture.adapter.resolveModel(request.provider, request.model, signal)).resolves.toMatchObject({
    id: request.model,
  })
  fixture.fetch.mockResolvedValueOnce(completionWire(request.model, [
    [{ role: 'assistant', content: 'Confirmed' }, null], [{}, 'stop'],
  ], 'fixture-completion'))
  const chunks = await streamParts(fixture.adapter.stream({
    ...request, sessionId: 'verboo-test-session' as NonNullable<GenerateOptions['sessionId']>,
  }))
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Confirmed' }))
  const [url, init] = fixture.fetch.mock.calls.at(-1)!
  expect(url instanceof Request ? url.url : String(url)).toBe('https://router.example.test/v1/chat/completions')
  const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined))
  expect(headers.get('authorization')).toBe('Bearer first-fixture-token')
  expect(headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/u)
})

it.each([undefined, 'fixture-malformed-response'])('sanitizes a malformed completion (%s)', async (responseId) => {
  const fixture = await catalogFixture()
  const request = inferenceRequest()
  await fixture.list()
  const warn = vi.spyOn(fixture.ctx.logger, 'warn').mockImplementation(() => {})
  fixture.fetch.mockResolvedValueOnce(completionWire(request.model, [
    [{
      role: 'assistant',
      tool_calls: [{
        index: 0, id: 'fixture-call', type: 'function',
        function: { name: 'count', arguments: '{"count":malformed-private-detail}' },
      }],
    }, null],
    [{}, 'tool_calls'],
  ], responseId))
  await expect(streamParts(fixture.adapter.stream(request))).rejects.toMatchObject({
    code: 'MALFORMED_RESPONSE',
    message: 'O modelo retornou uma chamada de ferramenta inválida. Tente novamente.',
  })
  expect(warn).toHaveBeenCalledWith('Verboo model response rejected: %o', expect.objectContaining({
    provider: request.provider, model: request.model,
  }))
  expect(JSON.stringify(warn.mock.calls)).not.toContain('malformed-private-detail')
})

it('refuses to use ambient authentication without the authorized account', async () => {
  const fixture = await catalogFixture()
  const request = inferenceRequest()
  fixture.account.resolveToken.mockResolvedValue(undefined)
  await expect(fixture.adapter.resolveModel(request.provider, request.model)).rejects.toMatchObject({
    code: 'ACCOUNT_SIGN_IN_REQUIRED',
  })
  await expect(streamParts(fixture.adapter.stream(request))).rejects.toMatchObject({
    code: 'ACCOUNT_SIGN_IN_REQUIRED',
  })
  await expect(fixture.adapter.prepareCall(request.provider, request.model)).rejects.toMatchObject({
    code: 'ACCOUNT_SIGN_IN_REQUIRED',
  })
  expect(fixture.fetch).not.toHaveBeenCalled()
})

it('does not dispatch a prepared request after crossing to another account', async () => {
  const fixture = await catalogFixture()
  const request = inferenceRequest()
  const prepared = await fixture.adapter.prepareCall(request.provider, request.model)
  fixture.setSession('second-session', 'second-fixture-token')
  await expect(streamParts(prepared.stream(request))).rejects.toMatchObject({ code: 'ACCOUNT_SIGN_IN_REQUIRED' })
  expect(fixture.fetch).toHaveBeenCalledOnce()
  expect(fixture.account.refreshRejectedToken).not.toHaveBeenCalled()
})

it('keeps refresh cancellation distinct from sign-out and transport failure', async () => {
  const fixture = await catalogFixture()
  await fixture.list()
  fixture.fetch.mockResolvedValueOnce(refusedInference())
  fixture.account.refreshRejectedToken.mockRejectedValueOnce(new AccountRequestError('request_cancelled'))
  await expect(streamParts(fixture.adapter.stream(inferenceRequest()))).rejects.toMatchObject({ code: 'ABORTED' })
  expect(fixture.account.refreshRejectedToken).toHaveBeenCalledOnce()
  expect(fixture.account.rejectToken).not.toHaveBeenCalled()
  expect(fixture.fetch).toHaveBeenCalledTimes(2)
})

it('does not replay an inference turn that was cancelled during refresh', async () => {
  const fixture = await catalogFixture()
  const controller = new AbortController()
  await fixture.list()
  fixture.fetch.mockResolvedValueOnce(refusedInference())
  fixture.account.refreshRejectedToken.mockImplementationOnce(async () => {
    controller.abort()
    return 'refreshed-fixture-token'
  })
  await expect(streamParts(fixture.adapter.stream({ ...inferenceRequest(), signal: controller.signal })))
    .rejects.toMatchObject({ code: 'ABORTED' })
  expect(fixture.fetch).toHaveBeenCalledTimes(2)
})

it('delivers usage around output even when the transport closes without a terminal frame', async () => {
  const fixture = await catalogFixture()
  const reported: StreamChunk = { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
  const delta: StreamChunk = { type: 'text-delta', index: 0, text: 'Confirmed' }
  const terminalUsage: StreamChunk = { type: 'usage', usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } }
  const stream = async function* () {
    yield reported
    yield delta
    yield terminalUsage
  }
  expect(await streamParts(VerbooModels.streamWithVerbooAuthentication(
    fixture.account, 'https://router.example.test/v1', stream,
  ))).toEqual([reported, delta, terminalUsage])
  expect(fixture.account.refreshRejectedToken).not.toHaveBeenCalled()
})

it.each(['retired', 'refused', 'unbound'] as const)('preserves the original failure for a %s refresh', async (state) => {
  const fixture = await catalogFixture()
  const refusal: StreamChunk = { type: 'finish', reason: { kind: 'error', failure: new LlmError('fixture', 'AUTH').failure } }
  const stream = vi.fn(async function* () { yield refusal })
  if (state === 'unbound') {
    const session = await fixture.account.getPlatformSession()
    fixture.account.getPlatformSession.mockResolvedValueOnce({
      origin: session!.origin, token: session!.token, userId: null,
    })
  } else if (state === 'retired') {
    fixture.account.refreshRejectedToken.mockImplementationOnce(async () => {
      fixture.setSession('second-session', 'second-fixture-token')
      return 'first-session-refreshed-token'
    })
  }
  expect(await streamParts(VerbooModels.streamWithVerbooAuthentication(
    fixture.account, 'https://router.example.test/v1', stream,
  ))).toEqual([refusal])
  expect(stream).toHaveBeenCalledOnce()
  expect(fixture.account.refreshRejectedToken).toHaveBeenCalledTimes(state === 'unbound' ? 0 : 1)
})

it('coalesces concurrent catalog reads for one live credential generation', async () => {
  const fixture = await catalogFixture()
  const entered = Promise.withResolvers<undefined>()
  const response = Promise.withResolvers<Response>()
  fixture.fetch.mockImplementationOnce(() => { entered.resolve(undefined); return response.promise })
  const first = fixture.list()
  await entered.promise
  const second = fixture.list()
  await vi.waitFor(() => { expect(fixture.account.getPlatformSession).toHaveBeenCalledTimes(2) })
  expect(fixture.fetch).toHaveBeenCalledOnce()
  response.resolve(Response.json({ data: [{ id: 'current-group/current-model' }] }))
  const firstModels = await first
  expect(firstModels.map(model => model.id)).toEqual(['current-group/current-model'])
  expect(await second).toEqual(firstModels)
  expect(fixture.fetch).toHaveBeenCalledOnce()
})

it('requires a live session before dispatching a catalog read', async () => {
  const fixture = await catalogFixture()
  fixture.account.getPlatformSession.mockResolvedValueOnce(null)
  expect(await fixture.list()).toEqual([])
  fixture.account.resolveToken.mockResolvedValueOnce(undefined)
  expect(await fixture.list()).toEqual([])
  expect(fixture.fetch).not.toHaveBeenCalled()
})

it('rejects only the credential challenged by the Router and keeps errors sanitized', async () => {
  const fixture = await catalogFixture()
  fixture.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }))
  await expect(fixture.list()).rejects.toMatchObject({ code: 'MODEL_LISTING_FAILED' })
  expect(fixture.account.rejectToken).toHaveBeenCalledExactlyOnceWith('first-fixture-token')
  fixture.fetch.mockResolvedValueOnce(Response.json({ data: 'fixture response body' }))
  await expect(fixture.list()).rejects.toMatchObject({ code: 'MODEL_LISTING_FAILED' })
  expect(fixture.account.rejectToken).toHaveBeenCalledOnce()
  expect((await fixture.list()).map(model => model.id)).toEqual(['current-group/current-model'])
})

it('refreshes an expired catalog under the same credential without treating it as a new sign-in', async () => {
  const fixture = await catalogFixture()
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  expect(await fixture.list()).toHaveLength(1)
  expect(await fixture.list()).toHaveLength(1)
  expect(fixture.fetch).toHaveBeenCalledOnce()
  clock.mockReturnValue(now + 86_400_000)
  fixture.fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 'current-group/new-model' }] }))
  expect((await fixture.list()).map(model => model.id)).toEqual(['current-group/new-model'])
  expect(fixture.fetch).toHaveBeenCalledTimes(2)
  expect(fixture.account.rejectToken).not.toHaveBeenCalled()
})

it('preserves the current credential when confirming the catalog owner fails', async () => {
  const fixture = await catalogFixture()
  const session = await fixture.account.getPlatformSession()
  fixture.account.getPlatformSession.mockResolvedValueOnce(session).mockRejectedValueOnce(new Error('internal vault detail'))
  await expect(fixture.list()).rejects.toMatchObject({ code: 'MODEL_LISTING_FAILED' })
  expect(fixture.account.rejectToken).not.toHaveBeenCalled()
  expect((await fixture.list()).map(model => model.id)).toEqual(['current-group/current-model'])
})

it('never lists the previous account’s models with a stale token after a switch', async () => {
  const fixture = await catalogFixture()
  const started = Promise.withResolvers<undefined>()
  const token = Promise.withResolvers<string>()
  fixture.account.resolveToken.mockImplementationOnce(() => { started.resolve(undefined); return token.promise })
  const listing = fixture.list()
  await started.promise
  fixture.setSession('second-session', 'second-fixture-token')
  token.resolve('first-fixture-token')
  expect(await listing).toEqual([])
  expect(fixture.fetch).not.toHaveBeenCalled()
  expect((await fixture.list()).map(model => model.id)).toEqual(['current-group/current-model'])
  const [url, init] = fixture.fetch.mock.calls[0]!
  expect(url).toBe('https://router.example.test/v1/models')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer second-fixture-token')
})

it('drops a model response from a retired credential generation', async () => {
  const fixture = await catalogFixture()
  const started = Promise.withResolvers<AbortSignal>()
  const response = Promise.withResolvers<Response>()
  fixture.fetch.mockImplementationOnce((_url, init) => { started.resolve(init!.signal!); return response.promise })
  const listing = fixture.list()
  const signal = await started.promise
  fixture.setSession('first-session', 'refreshed-fixture-token')
  fixture.ctx.emit('credentials/record-updated', 'verboo-account/default' as CredentialKey)
  expect(signal.aborted).toBe(true)
  const currentListing = fixture.list()
  try {
    await vi.waitFor(() => { expect(fixture.fetch).toHaveBeenCalledTimes(2) })
    expect((await currentListing).map(model => model.id)).toEqual(['current-group/current-model'])
  } finally {
    response.resolve(Response.json({ data: [{ id: 'retired-group/old-model' }] }))
  }
  expect(await listing).toEqual([])
  expect((await fixture.list()).map(model => model.id)).toEqual(['current-group/current-model'])
  expect(fixture.fetch).toHaveBeenCalledTimes(2)
})
