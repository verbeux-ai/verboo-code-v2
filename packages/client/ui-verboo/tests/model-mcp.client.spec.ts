import { describe, expect, it, vi } from 'vitest'
import type {
  AccountView,
  AccountCredentialRevision,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type { Connections } from '@deepseek-ai/dsh-api-verboo-product/types'
import type {
  CustomMcpServerView,
  McpResult,
  McpServerProbe,
  McpServerInput,
} from '@deepseek-ai/dsh-api-verboo-mcp/types'
import { ProductModel } from '../src/client/model.ts'
import type { ProductApi } from '../src/client/model.ts'

const view = (revision: string): AccountView => ({
  status: 'credential-stored',
  credentialRevision: revision as AccountCredentialRevision,
  attempt: null,
  links: {
    usageUrl: 'https://code.verboo.ai/pt/dashboard',
    topUpUrl: 'https://code.verboo.ai/pt/plans',
  },
})
const connections: Connections = { available: true, toolkits: [], accounts: [] }

const server = (overrides: Partial<CustomMcpServerView> = {}): CustomMcpServerView => ({
  name: 'docs',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headerNames: [],
  command: '',
  args: [],
  envNames: [],
  enabled: true,
  credentialRefs: [],
  createdAt: '2026-11-05T12:00:00Z',
  updatedAt: '2026-11-05T12:00:00Z',
  status: { state: 'connected', toolCount: 1, lastError: '', missing: [] },
  ...overrides,
})

const input = (overrides: Partial<McpServerInput> = {}): McpServerInput => ({
  name: 'docs',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headers: {},
  command: '',
  args: [],
  env: {},
  enabled: true,
  ...overrides,
})

const probe = (overrides: Partial<McpServerProbe> = {}): McpServerProbe => ({
  ok: true,
  stage: null,
  message: null,
  serverName: 'fixture',
  serverVersion: '1.0.0',
  toolNames: ['search'],
  truncated: false,
  durationMs: 12,
  ...overrides,
})

/** A presenter over stubbed product calls; each test overrides only what it exercises. */
function fixture(overrides: Partial<ProductApi> = {}) {
  const api: ProductApi = {
    profile: vi.fn(async () => null),
    start: vi.fn(async () => view('a')),
    cancel: vi.fn(async () => view('a')),
    signOut: vi.fn(async () => view('a')),
    plans: vi.fn(async () => ({ ok: true as const, data: { subscriptions: [], catalog: [] } })),
    connections: vi.fn(async () => ({ ok: true as const, data: connections })),
    connect: vi.fn(async () => ({
      ok: true as const,
      data: { url: 'https://connect.composio.dev/x', expiresAt: new Date(Date.now() + 60000).toISOString(), id: null },
    })),
    disconnect: vi.fn(async () => ({ ok: true as const, data: null })),
    billing: vi.fn(async () => ({ ok: true as const, data: 'https://code.verboo.ai/pt/plans' })),
    open: vi.fn(async () => {}),
    initializeModel: vi.fn(async () => true),
    mcpServers: vi.fn(async () => ({ ok: true as const, data: [server()] })),
    saveMcpServer: vi.fn(async () => ({ ok: true as const, data: server() })),
    deleteMcpServer: vi.fn(async () => ({ ok: true as const, data: null })),
    setMcpEnabled: vi.fn(async () => ({ ok: true as const, data: server({ enabled: false }) })),
    probeMcpServer: vi.fn(async () => ({ ok: true as const, data: probe() })),
    ...overrides,
  }
  return { api, model: new ProductModel(api, 30000) }
}

describe('MCP server reads', () => {
  it('joins concurrent reads into one Host call', async () => {
    const { api, model } = fixture()
    await Promise.all([model.loadMcpServers(), model.loadMcpServers()])
    expect(api.mcpServers).toHaveBeenCalledOnce()
    expect(model.state.getSnapshot().mcpServers).toEqual([server()])
  })

  it('keeps the Host reason when the read fails', async () => {
    const { model } = fixture({
      mcpServers: vi.fn(async () => ({ ok: false as const, code: 'contract_error' as const, message: 'store is not open' })),
    })
    await model.loadMcpServers()
    expect(model.state.getSnapshot().mcpFailed).toBe(true)
    expect(model.state.getSnapshot().mcpError).toBe('store is not open')
  })

  it('reports a thrown read as a failure without leaking the exception', async () => {
    const { model } = fixture({
      mcpServers: vi.fn(async () => { throw new Error('network down') }),
    })
    await model.loadMcpServers()
    expect(model.state.getSnapshot().mcpFailed).toBe(true)
    expect(model.state.getSnapshot().loadingMcp).toBe(false)
  })

  it('ignores a read that started before the account changed', async () => {
    const pending = Promise.withResolvers<McpResult<CustomMcpServerView[]>>()
    const { model } = fixture({ mcpServers: vi.fn(async () => pending.promise) })
    const reading = model.loadMcpServers()
    model.adopt(view('b'))
    pending.resolve({ ok: true, data: [server({ name: 'stale' })] })
    await reading
    expect(model.state.getSnapshot().mcpServers).toBeNull()
  })

  it('lets a read started before a write be discarded rather than overwrite it', async () => {
    const pending = Promise.withResolvers<McpResult<CustomMcpServerView[]>>()
    let reads = 0
    const { model } = fixture({
      mcpServers: vi.fn(async () => {
        reads += 1
        return reads === 1 ? pending.promise : { ok: true as const, data: [server({ enabled: false })] }
      }),
    })
    const stale = model.loadMcpServers()
    await model.setMcpEnabled('docs', false)
    pending.resolve({ ok: true, data: [server({ enabled: true })] })
    await stale
    // The reconciliation read after the write wins, not the read that predates it.
    expect(model.state.getSnapshot().mcpServers?.[0]?.enabled).toBe(false)
  })
})

describe('MCP server writes', () => {
  it('saves a definition and reconciles the list', async () => {
    const { api, model } = fixture()
    expect(await model.saveMcpServer(input())).toBe(true)
    expect(api.saveMcpServer).toHaveBeenCalledWith(input())
    expect(model.state.getSnapshot().feedback).toBe('mcpSaved')
    expect(model.state.getSnapshot().busy).toBeNull()
  })

  it('surfaces the Host refusal on a save and keeps it for the dialog', async () => {
    const { model } = fixture({
      saveMcpServer: vi.fn(async () => ({ ok: false as const, code: 'invalid_input' as const, message: 'name must match' })),
    })
    expect(await model.saveMcpServer(input())).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBe('mcp-save')
    expect(model.state.getSnapshot().mcpError).toBe('name must match')
    expect(model.state.getSnapshot().busy).toBeNull()
  })

  it('reports a thrown save as the same actionable failure', async () => {
    const { model } = fixture({
      saveMcpServer: vi.fn(async () => { throw new Error('offline') }),
    })
    expect(await model.saveMcpServer(input())).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBe('mcp-save')
    expect(model.state.getSnapshot().busy).toBeNull()
  })

  it('refuses a second write while one is in flight', async () => {
    const gate = Promise.withResolvers<McpResult<CustomMcpServerView>>()
    const { api, model } = fixture({ saveMcpServer: vi.fn(async () => gate.promise) })
    const first = model.saveMcpServer(input())
    expect(await model.deleteMcpServer('docs')).toBe(false)
    expect(api.deleteMcpServer).not.toHaveBeenCalled()
    gate.resolve({ ok: true, data: server() })
    expect(await first).toBe(true)
  })

  it('removes a definition and reports the outcome', async () => {
    const { api, model } = fixture()
    expect(await model.deleteMcpServer('docs')).toBe(true)
    expect(api.deleteMcpServer).toHaveBeenCalledWith('docs')
    expect(model.state.getSnapshot().feedback).toBe('mcpDeleted')
  })

  it('keeps a failed removal visible', async () => {
    const { model } = fixture({
      deleteMcpServer: vi.fn(async () => ({ ok: false as const, code: 'not_found' as const, message: 'gone' })),
    })
    expect(await model.deleteMcpServer('docs')).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBe('mcp-delete')
    expect(model.state.getSnapshot().mcpError).toBe('gone')
  })

  it('reports a thrown removal', async () => {
    const { model } = fixture({
      deleteMcpServer: vi.fn(async () => { throw new Error('offline') }),
    })
    expect(await model.deleteMcpServer('docs')).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBe('mcp-delete')
  })

  it('toggles a definition and confirms with feedback', async () => {
    const { api, model } = fixture()
    expect(await model.setMcpEnabled('docs', false)).toBe(true)
    expect(api.setMcpEnabled).toHaveBeenCalledWith('docs', false)
    expect(model.state.getSnapshot().feedback).toBeNull()
  })

  it('confirms an enabling toggle with feedback', async () => {
    const { model } = fixture()
    expect(await model.setMcpEnabled('docs', true)).toBe(true)
    expect(model.state.getSnapshot().feedback).toBe('mcpTick')
  })

  it('keeps a failed toggle actionable', async () => {
    const { model } = fixture({
      setMcpEnabled: vi.fn(async () => ({ ok: false as const, code: 'not_found' as const, message: 'missing' })),
    })
    expect(await model.setMcpEnabled('docs', true)).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBe('mcp-toggle')
  })

  it('reports a thrown toggle', async () => {
    const { model } = fixture({
      setMcpEnabled: vi.fn(async () => { throw new Error('offline') }),
    })
    expect(await model.setMcpEnabled('docs', true)).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBe('mcp-toggle')
  })

  it('ignores a write that settles after the account changed', async () => {
    const gate = Promise.withResolvers<McpResult<CustomMcpServerView>>()
    const { model } = fixture({ saveMcpServer: vi.fn(async () => gate.promise) })
    const saving = model.saveMcpServer(input())
    model.adopt(view('b'))
    gate.resolve({ ok: true, data: server() })
    expect(await saving).toBe(false)
    expect(model.state.getSnapshot().feedback).toBeNull()
  })
})

describe('MCP connection test', () => {
  it('publishes a successful outcome', async () => {
    const { model } = fixture()
    expect(await model.probeMcpServer(input())).toBe(true)
    expect(model.state.getSnapshot().mcpProbe).toEqual(probe())
    expect(model.state.getSnapshot().probingMcp).toBe(false)
  })

  it('publishes a failed probe as an outcome, not an error banner', async () => {
    const failed = probe({ ok: false, stage: 'connect', message: 'refused', toolNames: [] })
    const { model } = fixture({ probeMcpServer: vi.fn(async () => ({ ok: true as const, data: failed })) })
    expect(await model.probeMcpServer(input())).toBe(true)
    expect(model.state.getSnapshot().mcpProbe).toEqual(failed)
    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })

  it('keeps the Host reason when the probe could not run', async () => {
    const { model } = fixture({
      probeMcpServer: vi.fn(async () => ({ ok: false as const, code: 'invalid_input' as const, message: 'bad name' })),
    })
    expect(await model.probeMcpServer(input())).toBe(false)
    expect(model.state.getSnapshot().mcpProbe).toBeNull()
    expect(model.state.getSnapshot().mcpError).toBe('bad name')
    expect(model.state.getSnapshot().probingMcp).toBe(false)
  })

  it('reports a thrown probe', async () => {
    const { model } = fixture({
      probeMcpServer: vi.fn(async () => { throw new Error('offline') }),
    })
    expect(await model.probeMcpServer(input())).toBe(false)
    expect(model.state.getSnapshot().probingMcp).toBe(false)
  })

  it('refuses a second probe while one is running', async () => {
    const gate = Promise.withResolvers<McpResult<McpServerProbe>>()
    const { api, model } = fixture({ probeMcpServer: vi.fn(async () => gate.promise) })
    const first = model.probeMcpServer(input())
    expect(await model.probeMcpServer(input())).toBe(false)
    expect(api.probeMcpServer).toHaveBeenCalledOnce()
    gate.resolve({ ok: true, data: probe() })
    expect(await first).toBe(true)
  })

  it('drops the last outcome on request', async () => {
    const { model } = fixture()
    await model.probeMcpServer(input())
    model.clearMcpProbe()
    expect(model.state.getSnapshot().mcpProbe).toBeNull()
    expect(model.state.getSnapshot().mcpError).toBeNull()
  })
})

describe('MCP polling and account changes', () => {
  it('polls while a server is still settling', () => {
    const { model } = fixture()
    model.state.set({ ...model.state.getSnapshot(), mcpServers: [server({ status: { state: 'connecting', toolCount: 0, lastError: '', missing: [] } })] })
    expect(model.shouldPoll(Date.now())).toBe(true)
    model.state.set({ ...model.state.getSnapshot(), mcpServers: [server({ status: { state: 'connected', toolCount: 3, lastError: '', missing: [] } })] })
    expect(model.shouldPoll(Date.now())).toBe(false)
  })

  it('polls while a server reconnects', () => {
    const { model } = fixture()
    model.state.set({ ...model.state.getSnapshot(), mcpServers: [server({ status: { state: 'reconnecting', toolCount: 0, lastError: 'lost', missing: [] } })] })
    expect(model.shouldPoll(Date.now())).toBe(true)
  })

  it('clears MCP state when the account changes', async () => {
    const { model } = fixture()
    await model.loadMcpServers()
    expect(model.state.getSnapshot().mcpServers).not.toBeNull()
    model.adopt(view('b'))
    expect(model.state.getSnapshot().mcpServers).toBeNull()
    expect(model.state.getSnapshot().mcpProbe).toBeNull()
    expect(model.state.getSnapshot().mcpError).toBeNull()
  })

  it('resets MCP state on an explicit reset', async () => {
    const { model } = fixture()
    await model.loadMcpServers()
    model.reset()
    expect(model.state.getSnapshot().mcpServers).toBeNull()
  })
})
