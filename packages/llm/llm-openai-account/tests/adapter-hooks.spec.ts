/** Route behaviour the composed transport does not reach: adapters, refusals, and config bounds. */
import { expect, it, vi } from 'vitest'
import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveConfig } from '../src/config.ts'
import { CATALOG_PROVIDER, PROVIDER } from '../src/config.ts'
import { OpenAiAccountAdapter, quotaFailure, translatedChunks } from '../src/adapter.ts'

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
