/**
 * Real-composition check: the product extension must hand the MCP server tools
 * to an Agent created by the real loop, not only to a hand-mounted fixture.
 * A PENDING fork here would leave a conversation without the tools and without
 * an error, which is the failure this spec exists to catch.
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
  // The account-backed services the extension declares; stubs keep this spec
  // about tool wiring rather than the product API.
  ctx.provide('verbooProduct', {
    listAgentConnections: async () => '[]',
    searchAgentConnections: async () => '[]',
    executeAgentConnection: async () => '{}',
  } as never)
  ctx.provide('verbooMcp', {
    summaries: async () => [],
    saveFromClient: async () => ({ ok: true, data: null }),
    removeFromClient: async () => ({ ok: true, data: null }),
  } as never)
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
      'connections_execute',
      'mcp_servers_list',
      'mcp_server_save',
      'mcp_server_remove',
    ]))
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
    ctx.provide('verbooProduct', {
      listAgentConnections: async () => '[]',
      searchAgentConnections: async () => '[]',
      executeAgentConnection: async () => '{}',
    } as never)
    ctx.provide('verbooMcp', {
      summaries: async () => [],
      saveFromClient: async () => ({ ok: true, data: null }),
      removeFromClient: async () => ({ ok: true, data: null }),
    } as never)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('tool-wiring-late'), {
      provider: 'mock',
      model: 'mock',
    })
    await ctx.plugin(VerbooConnections, {})
    const names = ctx.tools.schemas(agent).map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining(['mcp_servers_list', 'mcp_server_save', 'mcp_server_remove']))
  })
})
