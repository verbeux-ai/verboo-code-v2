/**
 * Real-composition check for dynamic discovery: a scripted model calls
 * `connections_search`, and the tool it discovered is declared on the very next
 * request and executes against the account that search selected. A registry that
 * only registered outside the loop would pass a unit test and fail here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as VerbooConnections from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Stream one assistant text answer. */
function text(textValue: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: textValue },
    { type: 'block-end', index: 0, block: { type: 'text', text: textValue } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Stream one assistant tool call. */
function toolCall(callId: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(callId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Scripted adapter that records every request the loop builds. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][]) {
    super()
  }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const next = this.script.shift()
    if (next === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of next) yield chunk
  }
}

const catalog = JSON.stringify({
  available: true,
  accounts: [{ id: 'ca_work', toolkit: 'gmail', label: 'Work', status: 'connected' }],
  publicServices: [],
})

const searchEmail = {
  slug: 'GMAIL_SEARCH_EMAILS',
  name: 'Search emails',
  description: 'Find messages by query.',
  version: '20240101_00',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search text.' } },
    required: ['query'],
    additionalProperties: false,
  },
}

const sendEmail = {
  slug: 'GMAIL_SEND_EMAIL',
  name: 'Send email',
  description: 'Send a message.',
  version: '20240101_00',
  parameters: {
    type: 'object',
    properties: { to: { type: 'string' }, body: { type: 'string' } },
    required: ['to', 'body'],
    additionalProperties: false,
  },
}

/** Mount the shipped Host spine, this extension, and stub product services. */
async function harness(adapter: ScriptedAdapter, execute: ReturnType<typeof vi.fn>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  ctx.provide('verbooProduct', {
    listAgentConnections: async () => catalog,
    searchAgentConnections: async () => JSON.stringify([searchEmail, sendEmail]),
    executeAgentConnection: execute,
  } as never)
  ctx.provide('verbooMcp', {
    summaries: async () => [],
    saveFromClient: async () => ({ ok: true, data: null }),
    removeFromClient: async () => ({ ok: true, data: null }),
  } as never)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(VerbooConnections, {})
  const agent = await ctx.agentLoop.create(SessionId('discovery-loop'), { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

/** Admit one user message and wait for the turn to settle. */
async function send(agent: Agent, message: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('dynamic connection tools in a real turn', () => {
  it('declares the discovered tools on the next request and executes them in the same turn', async () => {
    const execute = vi.fn(async (input: { slug: string }) =>
      input.slug === 'GMAIL_SEARCH_EMAILS' ? '{"messages":[{"id":"m1"}]}' : '{"sent":true}')
    const adapter = new ScriptedAdapter([
      toolCall('call-1', 'connections_search', { query: 'find an email and reply' }),
      toolCall('call-2', 'connection__gmail__GMAIL_SEARCH_EMAILS', { query: 'from:ana' }),
      toolCall('call-3', 'connection__gmail__GMAIL_SEND_EMAIL', { to: 'ana@example.com', body: 'Thanks!' }),
      text('Sent the reply.'),
    ])
    const { agent } = await harness(adapter, execute)
    await send(agent, 'Find Ana’s email and reply')

    // The first request cannot know the provider tools; the second one must.
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).not.toContain('connection__gmail__GMAIL_SEARCH_EMAILS')
    expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'connection__gmail__GMAIL_SEARCH_EMAILS',
      'connection__gmail__GMAIL_SEND_EMAIL',
    ]))
    const declared = adapter.requests[1]?.tools?.find(tool => tool.name === 'connection__gmail__GMAIL_SEARCH_EMAILS')
    expect(declared?.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' } },
    })

    expect(execute).toHaveBeenNthCalledWith(1, {
      connectionId: 'ca_work',
      slug: 'GMAIL_SEARCH_EMAILS',
      version: '20240101_00',
      arguments: { query: 'from:ana' },
    }, expect.any(AbortSignal))
    expect(execute).toHaveBeenNthCalledWith(2, {
      connectionId: 'ca_work',
      slug: 'GMAIL_SEND_EMAIL',
      version: '20240101_00',
      arguments: { to: 'ana@example.com', body: 'Thanks!' },
    }, expect.any(AbortSignal))

    // The provider results reach the transcript, and the turn ends with the answer.
    const results = agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/result')
      .map(event => JSON.stringify(event.data))
    expect(results.some(result => result.includes('m1'))).toBe(true)
    expect(results.some(result => result.includes('sent'))).toBe(true)
  })

  it('tells the model to search when a task needs a connected service', async () => {
    const adapter = new ScriptedAdapter([text('ok')])
    const { agent } = await harness(adapter, vi.fn())
    await send(agent, 'hello')
    const system = adapter.requests[0]?.messages.find(message => message.role === 'system')
    const textOf = (content: unknown): string => Array.isArray(content)
      ? content.map(block => (block as { text?: string }).text ?? '').join('\n')
      : ''
    expect(textOf(system?.content)).toContain('connections_search')
  })
})
