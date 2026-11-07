/**
 * Tests for the MCP server tools: listing, the two approval-gated writes, and
 * the fail-closed path when a deployment mounts no approval channel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installMcpTools } from '../src/mcp-tools.ts'

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

const summary = {
  name: 'docs',
  transport: 'streamable-http' as const,
  target: 'https://mcp.example.com/mcp',
  enabled: true,
  state: 'connected',
  toolCount: 2,
  problem: '',
}

/** Mount the tool registry plus this contribution over a stub MCP service. */
async function mount(options: {
  outcome?: string
  withApproval?: boolean
  save?: unknown
  remove?: unknown
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const saved = vi.fn(async () => options.save ?? {
    ok: true,
    data: { ...summary, status: { state: 'connected', toolCount: 2, lastError: '', missing: [] } },
  })
  const removed = vi.fn(async () => options.remove ?? { ok: true, data: null })
  const listed = vi.fn(async () => [summary])
  ctx.provide('verbooMcp', { summaries: listed, saveFromClient: saved, removeFromClient: removed } as never)
  const requested = vi.fn(async () => options.outcome ?? 'allowed-once')
  if (options.withApproval !== false) {
    ctx.provide('approval', { request: requested } as never)
  }
  await ctx.plugin({
    name: 'verboo-mcp-tools-fixture',
    inject: ['tools', 'verbooMcp'],
    apply: (scope: Context) => { installMcpTools(scope, 5000) },
  }).await()
  return { ctx, saved, removed, listed, requested }
}

/** Parse one tool result body; the pipeline always produces JSON text. */
function parse(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) throw new Error('tool result was not a JSON object')
  return value as Record<string, unknown>
}

/** Run one registered definition through its real execute path (validation included). */
async function exec(ctx: Context, name: string, args: Record<string, unknown>): Promise<string> {
  const definition = ctx.tools.get(name)
  if (definition === undefined) throw new Error(`${name} is not registered`)
  const value = await definition.execute(args, {
    callId: 'call-1' as never,
    rootCallId: 'call-1' as never,
    token: 'token-1' as never,
    name,
    arguments: args,
    agent: { session: { append: () => undefined } } as unknown as Agent,
    signal: new AbortController().signal,
    deferContext: () => undefined,
  } as never)
  return typeof value === 'string' ? value : JSON.stringify(value)
}

describe('mcp_servers_list', () => {
  it('reports the stored definitions with their live state', async () => {
    const { ctx, listed } = await mount()
    const text = await exec(ctx, 'mcp_servers_list', {})
    expect(listed).toHaveBeenCalledTimes(1)
    expect(parse(text)).toEqual({
      servers: [
        {
          name: 'docs',
          transport: 'streamable-http',
          target: 'https://mcp.example.com/mcp',
          enabled: true,
          state: 'connected',
          toolCount: 2,
          problem: '',
        },
      ],
    })
  })
})

describe('mcp_server_save', () => {
  it('asks the human with the supplied justification before writing', async () => {
    const { ctx, saved, requested } = await mount()
    const text = await exec(ctx, 'mcp_server_save', {
      name: 'docs',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      justification: 'Add the docs server.',
    })
    expect(requested).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'mcp_server_save', reason: 'Add the docs server.' }),
    )
    expect(saved).toHaveBeenCalledWith({
      name: 'docs',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: {},
      command: '',
      args: [],
      env: {},
      enabled: true,
    })
    expect(parse(text)).toMatchObject({ ok: true, server: { name: 'docs', state: 'connected' } })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])('refuses the write when the answer is %s', async (outcome) => {
    const { ctx, saved } = await mount({ outcome })
    const text = await exec(ctx, 'mcp_server_save', {
      name: 'docs',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      justification: 'Add the docs server.',
    })
    expect(saved).not.toHaveBeenCalled()
    const body = parse(text)
    expect(body.ok).toBe(false)
    expect(body.code).toBe(outcome === 'rejected' ? 'not_approved' : outcome)
  })

  it('fails closed without an approval channel', async () => {
    const { ctx, saved } = await mount({ withApproval: false })
    const text = await exec(ctx, 'mcp_server_save', {
      name: 'docs',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      justification: 'Add the docs server.',
    })
    expect(saved).not.toHaveBeenCalled()
    expect(parse(text)).toMatchObject({ ok: false, code: 'approval_unavailable' })
  })

  it('returns the Host refusal verbatim so the model can correct the definition', async () => {
    const { ctx } = await mount({
      save: { ok: false, code: 'invalid_input', message: 'name must match [A-Za-z0-9_-]{1,32}' },
    })
    const text = await exec(ctx, 'mcp_server_save', {
      name: 'bad name',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      justification: 'Add the docs server.',
    })
    expect(parse(text)).toEqual({
      ok: false,
      code: 'invalid_input',
      message: 'name must match [A-Za-z0-9_-]{1,32}',
    })
  })

  it('drops a non-string header or environment value the model sent', async () => {
    const { ctx, saved } = await mount()
    await exec(ctx, 'mcp_server_save', {
      name: 'local',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 'abc', IGNORED: 7 },
      headers: { A: 'b' },
      enabled: false,
      justification: 'Add a local server.',
    })
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: 'stdio',
        args: ['-y', 'server'],
        env: { TOKEN: 'abc' },
        headers: { A: 'b' },
        enabled: false,
      }),
    )
  })

  it('refuses a non-string argument before asking the human', async () => {
    const { ctx, requested } = await mount()
    await expect(
      exec(ctx, 'mcp_server_save', {
        name: 'local',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 3],
        justification: 'Add a local server.',
      }),
    ).rejects.toThrow('must be a string')
    expect(requested).not.toHaveBeenCalled()
  })
})

describe('mcp_server_remove', () => {
  it('asks before removing and reports the removal', async () => {
    const { ctx, removed, requested } = await mount()
    const text = await exec(ctx, 'mcp_server_remove', {
      name: 'docs',
      justification: 'Remove the docs server.',
    })
    expect(requested).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'mcp_server_remove', reason: 'Remove the docs server.' }),
    )
    expect(removed).toHaveBeenCalledWith('docs')
    expect(parse(text)).toEqual({ ok: true, removed: 'docs' })
  })

  it('stops when the user rejects the removal', async () => {
    const { ctx, removed } = await mount({ outcome: 'rejected' })
    const text = await exec(ctx, 'mcp_server_remove', {
      name: 'docs',
      justification: 'Remove the docs server.',
    })
    expect(removed).not.toHaveBeenCalled()
    expect(parse(text)).toMatchObject({ ok: false, code: 'not_approved' })
  })
})
