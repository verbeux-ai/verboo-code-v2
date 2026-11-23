/** Route behaviour the composed transport does not reach: adapters, refusals, and config bounds. */
import { expect, it, vi } from 'vitest'
import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveConfig } from '../src/config.ts'
import { CATALOG_PROVIDER, PROVIDER } from '../src/config.ts'
import { OpenAiAccountAdapter, quotaFailure, translatedChunks } from '../src/adapter.ts'
import { ModelAvailability, offeredModels } from '../src/availability.ts'

/** A JWT-shaped fixture token carrying the account claim the transport reads. */
function tokenFor(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`
}

/** Credential reference a profile must name so pi-ai honours the request token. */
const TOKEN_REF = 'CHATGPT_ACCESS_TOKEN'

/** A resolved profile map over the installed Codex catalog. */
function profiles(): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  return resolveProfiles({ [CATALOG_PROVIDER]: { displayName: 'ChatGPT' } })
}

/** One failure with the fields this route rewrites. */
function failure(message: string, status?: number): LlmFailure {
  return { message, code: 'PI_AI_ERROR', ...status === undefined ? {} : { status } }
}

/** Drain a stream into its chunks. */
async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

it('accepts the optional request hooks the plugin supplies', () => {
  const adapter = new OpenAiAccountAdapter({
    profiles,
    accessToken: async () => tokenFor('acct-1'),
    resolveAttachments: () => undefined,
    resolveImageAccess: () => undefined,
    onReplayDegrade: () => {},
  })
  expect(adapter.providerInfo(PROVIDER)).toEqual({ id: PROVIDER, name: 'ChatGPT' })
})

it('resolves the account model through the installed catalog', async () => {
  const adapter = new OpenAiAccountAdapter({ profiles, accessToken: async () => 'fixture-token' })
  await expect(adapter.resolveModel(PROVIDER, 'gpt-5.5')).resolves.toMatchObject({ provider: PROVIDER, id: 'gpt-5.5' })
})

it('rejects a model the installed catalog does not describe', async () => {
  const adapter = new OpenAiAccountAdapter({ profiles, accessToken: async () => 'fixture-token' })
  await expect(adapter.resolveModel(PROVIDER, 'no-such-model')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
})

it('refuses a stop sequence, which the shared transport does not support', async () => {
  const adapter = new OpenAiAccountAdapter({ profiles, accessToken: async () => 'fixture-token' })
  await expect(drain(adapter.stream({ provider: PROVIDER, model: 'gpt-5.5', messages: [], stop: ['x'] })))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
})

it('reports a request-image target for an account model', () => {
  const adapter = new OpenAiAccountAdapter({ profiles, accessToken: async () => 'fixture-token' })
  const image = { id: 'image-1', variant: 'normalized', width: 1024, height: 512, bytes: 100 } as never
  expect(adapter.imageRequestTarget(PROVIDER, 'gpt-5.5', image)).toMatchObject({ width: 1024, height: 512 })
})

it('keeps the provider text and code when the failure names no limit', () => {
  expect(quotaFailure(failure('upstream exploded', 500))).toEqual(failure('upstream exploded', 500))
})

it('names the model as the remedy when the plan does not serve it', () => {
  // Waiting never helps here, so the sentence must send the reader to another
  // model rather than to a reset window.
  const refused = quotaFailure(failure("The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.", 400))
  expect(refused.code).toBe('UNSUPPORTED_MODEL')
  expect(refused.message).toContain('Choose another model')
  expect(refused.message).not.toContain('Codex')
  expect(refused.message).not.toContain('gpt-5.5')
})

it('keeps a limit a limit even when the model is also named', () => {
  // A spent window is the fact that governs the request; the model is not the
  // reason it was refused.
  const limited = quotaFailure(failure('rate limit reached for gpt-5.5, try again later', 429))
  expect(limited.code).not.toBe('UNSUPPORTED_MODEL')
})

it('does not rewrite a failure already carrying its final code', () => {
  const already: LlmFailure = { message: 'limit reached', code: QUOTA_EXCEEDED_CODE, status: 429 }
  expect(quotaFailure(already)).toBe(already)
})

it('keeps the provider text for a transient 429', () => {
  const transient = quotaFailure(failure('You have hit your ChatGPT usage limit (plus plan).', 429))
  expect(transient).toMatchObject({ code: 'RATE_LIMIT' })
  expect(transient.message).toBe('You have hit your ChatGPT usage limit (plus plan).')
})

it('rejects a usage deadline outside the timer bound', () => {
  expect(resolveConfig({ usageTimeoutMs: 250 })).toEqual({ usageTimeoutMs: 250 })
  expect(() => resolveConfig({ usageTimeoutMs: -1 })).toThrow(/usageTimeoutMs/)
  expect(() => resolveConfig({ usageTimeoutMs: 1_000 })).not.toThrow()
})

it('streams through the route key with the account credential', async () => {
  const requests: Array<{ url: string; headers: Headers }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push({ url: url.href, headers: new Headers(init?.headers) })
    return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })
  })
  const adapter = new OpenAiAccountAdapter({
    profiles: () => resolveProfiles({ [CATALOG_PROVIDER]: { apiKeyEnv: TOKEN_REF, displayName: 'ChatGPT' } }),
    accessToken: async () => tokenFor('acct-1'),
  })
  const chunks = await drain(adapter.stream({ provider: PROVIDER, model: 'gpt-5.5', messages: [] }))
  expect(requests[0]?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
})

it('serves prepareCall with the route key and the same translation', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }))
  const adapter = new OpenAiAccountAdapter({
    profiles: () => resolveProfiles({ [CATALOG_PROVIDER]: { apiKeyEnv: TOKEN_REF, displayName: 'ChatGPT' } }),
    accessToken: async () => tokenFor('acct-1'),
  })
  const prepared = await adapter.prepareCall(PROVIDER, 'gpt-5.5')
  expect(prepared.model).toMatchObject({ provider: PROVIDER, id: 'gpt-5.5' })
  const chunks = await drain(prepared.stream({ provider: PROVIDER, model: 'gpt-5.5', messages: [] }))
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
})

it.each(['accepted', 'unsupported', 'transient'] as const)(
  'records availability only from a settled account model result (%s)', async (outcome) => {
    const model = 'gpt-5.5'
    const item = { id: 'fixture-message', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'Ready.', annotations: [] }] }
    const completion = [
      { type: 'response.created', response: { id: 'fixture-response' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Ready.' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: {
        id: 'fixture-response', status: 'completed', output: [item],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const reply = outcome === 'accepted'
      ? new Response(completion, { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify({ error: { message: outcome === 'unsupported'
        ? "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account." : 'temporary server error' } }),
      { status: outcome === 'unsupported' ? 400 : 500 })
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply)
    const record = vi.fn()
    try {
      const adapter = new OpenAiAccountAdapter({
        profiles: () => resolveProfiles({ [CATALOG_PROVIDER]: { apiKeyEnv: TOKEN_REF, displayName: 'ChatGPT' } }),
        accessToken: async () => tokenFor('fixture-account'),
        accountId: async () => 'fixture-account',
        record,
      })
      const chunks = await drain(adapter.stream({ provider: PROVIDER, model, messages: [] }))
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: outcome === 'accepted' ? 'stop' : 'error' } })
      if (outcome === 'unsupported') expect(chunks.at(-1))
        .toMatchObject({ reason: { failure: { code: 'UNSUPPORTED_MODEL' } } })
      expect(record.mock.calls).toEqual(outcome === 'transient' ? [] : [
        ['fixture-account', model, outcome === 'accepted' ? 'supported' : 'unsupported'],
      ])
    } finally {
      mockFetch.mockRestore()
    }
  },
)

it('omits a model removed from the active provider catalog while assembling the picker', async () => {
  const resolved = profiles().get(CATALOG_PROVIDER)!
  const provider = resolved.piProvider!
  const changing = Object.create(provider) as typeof provider
  const models = vi.fn().mockReturnValueOnce(provider.getModels()).mockReturnValueOnce([])
  Object.defineProperty(changing, 'getModels', { value: models })
  const adapter = new OpenAiAccountAdapter({
    profiles: () => new Map([[CATALOG_PROVIDER, { ...resolved, piProvider: changing }]]),
    accessToken: async () => tokenFor('fixture-account'),
  })
  await expect(adapter.listModels(PROVIDER)).resolves.toEqual([])
  expect(models).toHaveBeenCalledTimes(2)
})

it('delivers the unsupported-model code in the finish chunk the loop records', async () => {
  // The turn's recorded failure comes from this chunk, so the code must survive
  // the translation rather than only existing in a helper.
  const refusal = "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."
  const chunks = translatedChunks((async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: refusal, code: 'PI_AI_ERROR' } } } as never
  })())
  const seen: unknown[] = []
  for await (const chunk of chunks) seen.push(chunk)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'UNSUPPORTED_MODEL' } },
  })
})

it('passes the reasoning levels the catalog declares through to the picker', async () => {
  // The effort rail reads these from the resolved model, so a level the catalog
  // declares must survive this route rather than being flattened away.
  const adapter = new OpenAiAccountAdapter({ profiles, accessToken: async () => 'fixture-token' })
  const info = await adapter.resolveModel(PROVIDER, 'gpt-6-sol')
  expect(info.provider).toBe(PROVIDER)
  expect(info.id).toBe('gpt-6-sol')
  // The catalog declares a full ladder for this model; the route must not
  // report an empty one, which is what a missing spread would produce.
  expect(info.reasoning?.efforts.length ?? 0).toBeGreaterThan(0)
  expect(info.reasoning?.efforts.map(effort => effort.id)).toContain('high')
})

it('withholds a model whose refusal arrives already translated', async () => {
  // The route's own translation replaces the provider wording before any reader
  // sees the failure, so discovery must recognise the translated code too.
  // Reading only the message made every refused model stay in the menu.
  const store = new ModelAvailability()
  store.record('acct-1', 'gpt-5.5', 'unsupported')
  store.record('acct-1', 'gpt-6-sol', 'supported')
  expect(offeredModels(['gpt-5.5', 'gpt-6-sol'], store.read('acct-1'))).toEqual(['gpt-6-sol'])
})

it('recognises the translated code as a refusal, not a limit', () => {
  // The two classifications send the reader to different remedies; a refusal
  // that reads as a limit would tell them to wait for a window that refuses again.
  const translated: LlmFailure = {
    message: 'This ChatGPT plan does not serve the selected model. Choose another model, or switch to a Verboo model.',
    code: 'UNSUPPORTED_MODEL',
  }
  expect(quotaFailure(translated).code).toBe('UNSUPPORTED_MODEL')
})
