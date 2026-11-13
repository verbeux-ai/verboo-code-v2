/** The route's own translation surface, exercised without the shared runtime. */
import { expect, it } from 'vitest'
import { LlmError, QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import { CATALOG_PROVIDER, PROVIDER, resolveConfig } from '../src/config.ts'
import {
  CREDITS_MESSAGE,
  DISPLAY_NAME,
  OpenAiAccountAdapter,
  SIGN_IN_MESSAGE,
  USAGE_LIMIT_MESSAGE,
  quotaFailure,
  translatedChunks,
} from '../src/adapter.ts'
import { accountIdFromToken } from '../src/usage.ts'
import type { SubscriptionUsage } from '../src/types.ts'

/** The route's resolved profile map, over the installed Codex catalog. */
const profiles = () => resolveProfiles({ [CATALOG_PROVIDER]: { displayName: DISPLAY_NAME } })

/** An adapter over the installed catalog with a fixed session. */
function adapter(accessToken: () => Promise<string | undefined> = async () => 'fixture-token') {
  return new OpenAiAccountAdapter({ profiles, accessToken })
}

/** One request the route can serve, without touching a provider. */
const request: GenerateOptions = { provider: PROVIDER, model: 'gpt-5.5', messages: [] }

/** A failure the transport produced, with the fields this route rewrites. */
function failure(message: string, status?: number): LlmFailure {
  return { message, code: 'PI_AI_ERROR', ...status === undefined ? {} : { status } }
}

/** Drain a chunk stream into its chunks. */
async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const collected: StreamChunk[] = []
  for await (const chunk of chunks) collected.push(chunk)
  return collected
}

it('names the route after the product, not the configuration key', () => {
  expect(adapter().providerInfo(PROVIDER)).toEqual({ id: PROVIDER, name: 'ChatGPT' })
})

it('keeps the harness default retry policy for the route', () => {
  expect(adapter().providerRetryPolicy(PROVIDER)).toBeUndefined()
})

it('resolves a model under this route key', async () => {
  const resolved = await adapter().resolveModel(PROVIDER, 'gpt-5.5')
  expect(resolved).toMatchObject({ provider: PROVIDER, id: 'gpt-5.5' })
  expect(resolved.context?.contextWindow).toBeGreaterThan(0)
})

it('resolves the request-image target through the shared transport', () => {
  const image = { id: 'image-1', variant: 'normalized', width: 2048, height: 1024, bytes: 1000 }
  expect(adapter().imageRequestTarget(PROVIDER, 'gpt-5.5', image as never)).toMatchObject({ width: 2048 })
})

it('lists no model when the profile carries no installed provider', async () => {
  const bare = new OpenAiAccountAdapter({ profiles: () => new Map(), accessToken: async () => 'fixture-token' })
  expect(await bare.listModels(PROVIDER)).toEqual([])
})

it('fails a call with a typed sign-in error when the session yields no token', async () => {
  await expect(drain(adapter(async () => undefined).stream(request))).rejects.toMatchObject({
    code: 'ACCOUNT_SIGN_IN_REQUIRED',
    message: SIGN_IN_MESSAGE,
  })
})

it('reports an unsupported option from the shared transport unchanged', async () => {
  await expect(drain(adapter().stream({ ...request, stop: ['x'] }))).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
})

it('classifies both delivery styles of one terminal refusal', async () => {
  const failureChunk = (message: string, status?: number): StreamChunk => ({
    type: 'finish',
    reason: { kind: 'error', failure: failure(message, status) },
  })
  const chunks = async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'partial' }
    yield failureChunk('{"rate_limit_reached_type":"workspace_owner_usage_limit_reached"}')
  }
  const out = await drain(translatedChunks(chunks()))
  expect(out[0]).toEqual({ type: 'text-delta', index: 0, text: 'partial' })
  expect(out[1]).toMatchObject({ reason: { kind: 'error', failure: { code: QUOTA_EXCEEDED_CODE, message: USAGE_LIMIT_MESSAGE } } })

  const thrown = async function* (): AsyncIterable<StreamChunk> {
    throw new LlmError('{"rate_limit_reached_type":"workspace_member_credits_depleted"}', 'RATE_LIMIT', { status: 429 })
  }
  await expect(drain(translatedChunks(thrown()))).rejects.toMatchObject({
    code: ACCOUNT_QUOTA_EXCEEDED_CODE,
    message: CREDITS_MESSAGE,
  })
})

it('passes a failure that names no limit through untouched', async () => {
  const thrown = async function* (): AsyncIterable<StreamChunk> {
    throw new LlmError('provider busy', 'SERVER', { status: 500 })
  }
  await expect(drain(translatedChunks(thrown()))).rejects.toMatchObject({ code: 'SERVER', message: 'provider busy' })

  const foreign = async function* (): AsyncIterable<StreamChunk> {
    throw new TypeError('not an LlmError')
  }
  await expect(drain(translatedChunks(foreign()))).rejects.toThrow(TypeError)
})

it('classifies a refusal without a status from its structured reason only', () => {
  expect(quotaFailure(failure('{"rate_limit_reached_type":"workspace_owner_usage_limit_reached"}')))
    .toMatchObject({ code: QUOTA_EXCEEDED_CODE })
  expect(quotaFailure(failure('nothing to see'))).toEqual(failure('nothing to see'))
})

it('leaves a failure already carrying its final code alone', () => {
  const already: LlmFailure = { message: 'limit reached', code: QUOTA_EXCEEDED_CODE, status: 429 }
  expect(quotaFailure(already)).toBe(already)
})

it('keeps the provider text for a transient refusal', () => {
  expect(quotaFailure(failure('You have hit your ChatGPT usage limit (plus plan).', 429)))
    .toMatchObject({ code: 'RATE_LIMIT', message: 'You have hit your ChatGPT usage limit (plus plan).' })
})

it('reads the account identifier from the token claim', () => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const token = `${encode({})}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } })}.sig`
  expect(accountIdFromToken(token)).toBe('acct-9')
  expect(accountIdFromToken('opaque-token')).toBeUndefined()
  expect(accountIdFromToken('a.b.c')).toBeUndefined()
  expect(accountIdFromToken(`${encode({})}.${encode({ other: 1 })}.sig`)).toBeUndefined()
  expect(accountIdFromToken(`${encode({})}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: '' } })}.sig`))
    .toBeUndefined()
})

it('rejects a usage deadline outside the timer bound', () => {
  expect(resolveConfig({})).toEqual({ usageTimeoutMs: 10_000 })
  expect(resolveConfig({ usageTimeoutMs: 25 })).toEqual({ usageTimeoutMs: 25 })
  expect(() => resolveConfig({ usageTimeoutMs: 0 })).toThrow(/usageTimeoutMs/)
  expect(() => resolveConfig({ usageTimeoutMs: Number.NaN })).toThrow(/usageTimeoutMs/)
})

/** Keep the reading type referenced so the module's public surface stays checked. */
export type ReadingSurface = SubscriptionUsage
