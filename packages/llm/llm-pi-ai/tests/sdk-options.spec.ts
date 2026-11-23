import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'

const streamSimple = vi.hoisted(() => vi.fn())

// A hand-declared route is built by `createProvider` over the protocol table in
// `src/provider.ts`, so the table's lazy api module is the SDK boundary this
// test can observe. A catalog route dispatches through pi-ai's own provider and
// would not see this mock.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => { streamSimple.mockReset() })

/** A hand-declared OpenAI-compatible route with one fully described model. */
function gatewayAdapter(): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'local-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

async function drain(adapter: PiAiAdapter, chunks: StreamChunk[] = []): Promise<StreamChunk[]> {
  for await (const chunk of adapter.stream({
    provider: 'local-gateway',
    model: 'local-model',
    messages: [],
  })) chunks.push(chunk)
  return chunks
}

describe('pi-ai SDK retry boundary', () => {
  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    const chunks = await drain(gatewayAdapter())

    expect(streamSimple).toHaveBeenCalledOnce()
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, apiKey: 'test-key' })
    // pi-ai reports a setup failure as a terminal in-stream error rather than
    // throwing, which the converter turns into the harness error finish.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'mock SDK boundary' } },
    })
  })

  it('dispatches a hand-declared route to the endpoint and model its configuration describes', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    expect(streamSimple.mock.calls[0]?.[0]).toMatchObject({
      id: 'local-model',
      provider: 'local-gateway',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 8192,
      maxTokens: 1024,
    })
  })
})

describe('provider stream identity validation after SDK normalization', () => {
  it.each([
    ['toolUse', undefined],
    ['length', { kind: 'max-tokens' }],
    ['error', { kind: 'error', failure: { code: 'SERVER' } }],
    ['aborted', { kind: 'aborted' }],
  ] as const)('blocks conflicting completed calls and preserves %s', async (stopReason, expected) => {
    const toolCall = { type: 'toolCall', id: 'fixture-call', name: 'count', arguments: {} } as const
    const message: AssistantMessage = {
      role: 'assistant', api: 'openai-completions', provider: 'local-gateway', model: 'local-model',
      content: [toolCall], timestamp: 0, stopReason,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }
    streamSimple.mockImplementation(async function* (
      _model, _context, options: { onProviderStreamEvent: (chunk: unknown) => void },
    ): AsyncGenerator<AssistantMessageEvent> {
      options.onProviderStreamEvent({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'fixture-call' }, { index: 1, id: 'fixture-call' },
      ] } }] })
      // The SDK consolidated the conflicting wire entries into one valid call.
      yield { type: 'toolcall_start', contentIndex: 0, partial: message }
      yield { type: 'toolcall_end', contentIndex: 0, toolCall, partial: message }
      if (stopReason === 'error' || stopReason === 'aborted') {
        yield { type: 'error', reason: stopReason, error: { ...message, errorMessage: '502 provider unavailable' } }
      } else {
        yield { type: 'done', reason: stopReason, message }
      }
    })
    const chunks: StreamChunk[] = []
    const result = drain(gatewayAdapter(), chunks)
    if (expected === undefined) await expect(result).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    else expect((await result).at(-1)).toMatchObject({ type: 'finish', reason: expected })
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
  })
})
