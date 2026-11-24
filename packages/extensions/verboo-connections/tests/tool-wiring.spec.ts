/**
 * Real-composition check: the product extension must hand the connection and
 * MCP tools to an Agent created by the real loop, not only to a hand-mounted
 * fixture. A PENDING fork here would leave a conversation without the tools and
 * without an error, which is the failure this spec exists to catch.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
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

/** One connected account and one provider action, so a search can register a tool. */
const CATALOG = JSON.stringify({
  available: true,
  accounts: [{ id: 'ca_work', toolkit: 'gmail', label: 'Work', status: 'connected' }],
  publicServices: [],
})

const SEARCH_EMAIL = {
  slug: 'GMAIL_SEARCH_EMAILS',
  name: 'Search emails',
  description: 'Find messages by query.',
  version: '20240101_00',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}

/** Provide the two account-backed services this extension declares. */
function provideProductStubs(ctx: Context): void {
  ctx.provide('verbooProduct', {
    listAgentConnections: async () => CATALOG,
    searchAgentConnections: async () => JSON.stringify([SEARCH_EMAIL]),
    executeAgentConnection: async () => '{}',
  } as never)
  ctx.provide('verbooMcp', {
    summaries: async () => [],
    saveFromClient: async () => ({ ok: true, data: null }),
    removeFromClient: async () => ({ ok: true, data: null }),
  } as never)
}

/** Mount the shipped Host spine plus this extension over stub product services. */
async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  provideProductStubs(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(VerbooConnections, {})
  return ctx
}

describe('product tool wiring for a real Agent', () => {
  it('gives a newly created Agent the connection and MCP tools', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('tool-wiring'), {
      provider: 'mock',
      model: 'mock',
    })
    const names = ctx.tools.schemas(agent).map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'connections_list',
      'connections_search',
      'mcp_servers_list',
      'mcp_server_save',
      'mcp_server_remove',
    ]))
    // Discovery replaced the generic execute tool: provider actions are callable
    // as their own tools once a search adds them.
    expect(names).not.toContain('connections_execute')
  })

  it('gives an Agent that already exists when the extension mounts the same tools', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    provideProductStubs(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('tool-wiring-late'), {
      provider: 'mock',
      model: 'mock',
    })
    await ctx.plugin(VerbooConnections, {})
    const names = ctx.tools.schemas(agent).map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'connections_search',
      'mcp_servers_list',
      'mcp_server_save',
      'mcp_server_remove',
    ]))
  })

  it('withdraws the tools a search discovered when the extension unloads', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    provideProductStubs(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const fiber = ctx.plugin(VerbooConnections, {})
    await fiber.await()
    const agent = await ctx.agentLoop.create(SessionId('tool-wiring-dispose'), {
      provider: 'mock',
      model: 'mock',
    })
    const search = ctx.tools.get('connections_search', agent)
    if (search === undefined) throw new Error('connections_search is not registered')
    await search.execute({ query: 'search email' }, {
      callId: 'call-1',
      token: 'token-1',
      name: 'connections_search',
      arguments: { query: 'search email' },
      signal: new AbortController().signal,
      deferContext: () => undefined,
    } as never)
    expect(ctx.tools.schemas(agent).map(tool => tool.name))
      .toContain('connection__gmail__GMAIL_SEARCH_EMAILS')

    await fiber.dispose()
    expect(ctx.tools.schemas(agent).map(tool => tool.name))
      .not.toContain('connection__gmail__GMAIL_SEARCH_EMAILS')
  })
})
