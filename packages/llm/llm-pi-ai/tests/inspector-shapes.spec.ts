/** The tool-call id inspector and the stream guards, over malformed wire shapes. */
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

/** Mount the runtime with one openai-completions fixture adapter. */
async function collect(events: string[]) {
  const server = await mockServer([{ events: events as never }])
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new PiAiAdapter({
    profiles: () => resolveProfiles({ fixture: { api: 'openai-completions', baseURL: server.url, models: [{ id: 'm' }], transport: 'sse' } }),
    resolveApiKey: () => Promise.resolve('fixture-key'),
    auth: memoryAuth(),
  })))
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: 'fixture', model: 'm', messages: [] })) {
    assembler.push(chunk)
  }
  return { assembler, server }
}

describe('the id inspector over malformed wire shapes', () => {
  it.each([
    ['a non-object chunk', '42'],
    ['a null chunk', 'null'],
    ['an id-less chunk', JSON.stringify({ id: 'r1' })],
    ['a choice without delta', JSON.stringify({ choices: [{ index: 0 }] })],
    ['a null delta', JSON.stringify({ choices: [{ index: 0, delta: null }] })],
    ['a delta without tool calls', JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] })],
    ['a tool call with an index but no id', JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'a' } }] } }] })],
    ['non-array tool calls', JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: 'nope' } }] })],
  ])('ignores %s without marking duplication', async (_case, wire) => {
    const events = [wire, JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), '[DONE]']
    const { assembler } = await collect(events)
    // The inspector never marks duplication for these shapes: the stream does
    // not end in the reused-id MALFORMED_RESPONSE failure.
    expect(assembler.finish).not.toMatchObject({
      kind: 'error',
      failure: { code: 'MALFORMED_RESPONSE', message: '[OI]-compatible response reused a tool-call id' },
    })
  })

  it('marks duplication when one index carries two ids', async () => {
    const events = [
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } }] } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'b', arguments: '{}' } }] } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      '[DONE]',
    ]
    const { assembler } = await collect(events)
    const finish = assembler.finish as { kind: string; failure: { code: string; message: string } }
    expect(finish.kind).toBe('error')
    expect(finish.failure.code).toBe('MALFORMED_RESPONSE')
  })
})
declare module '@deepseek-ai/dsh-llm' {
  interface LlmRequestPurposeMap {
    'fixture-purpose': true
  }
}

describe('the auxiliary purpose passthrough', () => {
  it('forwards a declared purpose to the prepared request headers', async () => {
    const server = await mockServer([{ events: [
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      '[DONE]',
    ] as never }])
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    let seenPurpose: unknown
    ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new PiAiAdapter({
      profiles: () => resolveProfiles({ fixture: { api: 'openai-completions', baseURL: server.url, models: [{ id: 'm' }], transport: 'sse' } }),
      resolveApiKey: () => Promise.resolve('fixture-key'),
      auth: memoryAuth(),
      prepareHeaders: (request, headers) => { seenPurpose = request.purpose; return headers },
    })))
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider: 'fixture', model: 'm', messages: [], purpose: 'fixture-purpose' as never })) {
      assembler.push(chunk)
    }
    expect(seenPurpose).toBe('fixture-purpose')
  })
})

describe('the duplicated-id terminal guards', () => {
  /** Two tool-call deltas on the same index with different ids. */
  const duplicated = (): string[] => [
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'a', arguments: '{}' } }] } }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'b', arguments: '{}' } }] } }] }),
  ]

  it('lets an aborted finish through without the duplicated-id refusal', async () => {
    const aborter = new AbortController()
    const events = [
      ...duplicated(),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      '[DONE]',
    ]
    const server = await mockServer([{ events }])
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new PiAiAdapter({
      profiles: () => resolveProfiles({ fixture: { api: 'openai-completions', baseURL: server.url, models: [{ id: 'm' }], transport: 'sse' } }),
      resolveApiKey: () => Promise.resolve('fixture-key'),
      auth: memoryAuth(),
    })))
    // Aborting before the terminal chunk arrives makes the terminal reason
    // aborted, which is the one outcome the guard must not refuse.
    const pending = (async () => {
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream({ provider: 'fixture', model: 'm', messages: [], signal: aborter.signal })) {
        assembler.push(chunk)
        if (chunk.type === 'tool-call-delta') aborter.abort()
      }
      return assembler.finish
    })()
    await expect(pending).resolves.toMatchObject({ kind: 'aborted' })
  })

  it('lets a max-tokens finish through without the duplicated-id refusal', async () => {
    const events = [
      ...duplicated(),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      '[DONE]',
    ]
    const { assembler } = await collect(events)
    expect(assembler.finish).toMatchObject({ kind: 'max-tokens' })
  })

  it('keeps the block-end chunk out of a duplicated-id stream', async () => {
    const { assembler } = await collect([
      ...duplicated(),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      '[DONE]',
    ])
    expect(assembler.finish.kind).toBe('error')
  })
})
