/**
 * Tests for the user-defined MCP server service: write validation, credential
 * separation, durable definitions, live registration on the shared MCP fleet,
 * enable/disable, removal, and the connection test.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Transport } from '@modelcontextprotocol/client'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

const { mockConnect, mockListTools, MockClient, instances, transportConfigs, identity } = vi.hoisted(() => {
  const identity: { value: { name: string; version: string } | undefined } = {
    value: { name: 'fixture', version: '1.0.0' },
  }
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  class MockClient {
    transport: Transport | undefined
    async connect(transport: Transport): Promise<void> {
      this.transport = transport
      const onclose = transport.onclose
      transport.onclose = () => { onclose?.() }
      await transport.start()
      await mockConnect.call(this)
    }
    async close(): Promise<void> { await this.transport?.close() }
    request = async (request: { method: string }): Promise<unknown> => {
      if (request.method === 'tools/list') return await mockListTools()
      throw new Error(`unexpected MCP request: ${request.method}`)
    }
    listTools = mockListTools
    getServerCapabilities = () => ({ tools: {} })
    getInstructions = (): string | undefined => undefined
    listResources = async () => ({ resources: [] })
    getServerVersion = () => identity.value
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  const transportConfigs: Array<Record<string, unknown>> = []
  return { mockConnect, mockListTools, MockClient, instances, transportConfigs, identity }
})

vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function (config: Record<string, unknown>) {
    transportConfigs.push(config)
    return new (class {
      onclose?: () => void
      start = async () => {}
      send = async () => {}
      close = async () => { this.onclose?.() }
    })()
  }),
}))
vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(function (url: URL, options: Record<string, unknown>) {
    transportConfigs.push({ url: url.href, ...options })
    return new (class {
      onclose?: () => void
      start = async () => {}
      send = async () => {}
      close = async () => { this.onclose?.() }
    })()
  }),
}))

import McpServerManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import VerbooMcpServers from '../src/index.ts'
import type { McpServerInput } from '../src/types.ts'

/** Minimal real credential provider: the reference half is a map. */
class MemoryCredentials extends CredentialProvider {
  readonly values = new Map<string, string>()
  get writable(): boolean { return true }
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(String(ref))
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }
  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.values.has(String(ref)), writable: true } as CredentialInfo)
  }
  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(String(ref), value)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }
  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(String(ref))
    this.notifyUpdated(ref)
    return Promise.resolve()
  }
  readRecord(): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  describeRecord(): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: false } as CredentialRecordInfo)
  }
  listRecords(): Promise<readonly CredentialRecordEntry[]> { return Promise.resolve([]) }
  modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }
  deleteRecord(_key: CredentialKey): Promise<void> { return Promise.resolve() }
}

const roots: string[] = []
const contexts: Context[] = []

beforeEach(() => {
  mockConnect.mockReset().mockResolvedValue(undefined)
  mockListTools.mockReset().mockResolvedValue({ tools: [], nextCursor: undefined })
  instances.length = 0
  transportConfigs.length = 0
  identity.value = { name: 'fixture', version: '1.0.0' }
})

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

/** Mount the MCP fleet, credentials and this service on one Host context. */
async function mount(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-verboo-mcp-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const manager = ctx.plugin(McpServerManager, {})
  await manager.await()
  const service = ctx.plugin(VerbooMcpServers, config)
  await service.await()
  onTestFinished(() => undefined)
  return { ctx, service: ctx.verbooMcp, credentials: ctx.get('credentials') as MemoryCredentials }
}

const httpInput = (overrides: Partial<McpServerInput> = {}): McpServerInput => ({
  name: 'docs',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: 'Bearer secret-token' },
  command: '',
  args: [],
  env: {},
  enabled: true,
  ...overrides,
})

/** Minimal read surface the polling helper needs. */
interface ListedView {
  name: string
  status: { state: string }
}

/** Poll the service until one definition reports the expected state. */
async function settled(
  service: { listFromClient(): Promise<{ ok: true; data: ListedView[] } | { ok: false }> },
  name: string,
  state: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const listed = await service.listFromClient()
    if (listed.ok && listed.data.find(entry => entry.name === name)?.status.state === state) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const listed = await service.listFromClient()
  const states = listed.ok ? listed.data.map(entry => entry.status.state) : listed
  throw new Error(`${name} never reached ${state}: ${JSON.stringify(states)}`)
}

describe('definition writes', () => {
  it('stores keys and credential references, never a secret value', async () => {
    const { service, credentials } = await mount()
    const result = await service.saveFromClient(httpInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({
      name: 'docs',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headerNames: ['Authorization'],
      envNames: [],
      enabled: true,
    })
    expect(JSON.stringify(result.data)).not.toContain('secret-token')
    expect(result.data.credentialRefs).toEqual(['VERBOO_MCP_DOCS_AUTHORIZATION'])
    expect(credentials.values.get('VERBOO_MCP_DOCS_AUTHORIZATION')).toBe('Bearer secret-token')
    expect(result.data.status.missing).toEqual([])
  })

  it('keeps a stored secret when the edit submits a blank value', async () => {
    const { service, credentials } = await mount()
    await service.saveFromClient(httpInput())
    const edited = await service.saveFromClient(httpInput({ headers: { Authorization: '' } }))
    expect(edited.ok).toBe(true)
    expect(credentials.values.get('VERBOO_MCP_DOCS_AUTHORIZATION')).toBe('Bearer secret-token')
  })

  it('reports a reference with no stored value as missing', async () => {
    const { service } = await mount()
    const saved = await service.saveFromClient(httpInput({ headers: {} }))
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const view = await service.listFromClient()
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect(view.data[0]?.status.missing).toEqual([])
    const withBlank = await service.saveFromClient(
      httpInput({ headers: { Authorization: '' } }),
    )
    expect(withBlank.ok).toBe(true)
  })

  it.each([
    ['a name outside the pattern', httpInput({ name: 'bad name' }), 'name must match'],
    ['a stdio server without a command', {
      name: 'local', transport: 'stdio' as const, url: '', headers: {},
      command: '', args: [], env: {}, enabled: true,
    }, 'command'],
    ['an http server without an endpoint', httpInput({ url: '' }), 'url'],
    ['cross-transport headers on stdio', {
      name: 'local', transport: 'stdio' as const, url: '', headers: { A: 'b' },
      command: 'node', args: [], env: {}, enabled: true,
    }, 'headers'],
    ['a cleartext non-loopback endpoint', httpInput({ url: 'http://example.com/mcp' }), 'https'],
    ['credentials in the URL', httpInput({ url: 'https://user:pass@example.com/mcp' }), 'credentials in the URL'],
    ['a malformed template', {
      name: 'local', transport: 'stdio' as const, url: '', headers: {},
      command: 'node', args: ['${x${credential:A}'], env: {}, enabled: true,
    }, 'not a template token'],
  ])('refuses %s', async (_label, input, message) => {
    const { service } = await mount()
    const result = await service.saveFromClient(input)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid_input')
    expect(result.message).toContain(message)
  })

  it('accepts every budget override', async () => {
    const { service } = await mount({
      startupTimeoutMs: 1000,
      toolCallTimeoutMs: 1000,
      probeTimeoutMs: 1000,
      probeMaxToolNames: 1,
      maxServers: 1,
    })
    const result = await service.saveFromClient(httpInput())
    expect(result.ok).toBe(true)
  })

  it('accepts a loopback cleartext endpoint for a local server', async () => {
    const { service } = await mount()
    const result = await service.saveFromClient(httpInput({ url: 'http://127.0.0.1:8080/mcp' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.url).toBe('http://127.0.0.1:8080/mcp')
  })

  it('keeps the creation instant across an edit and moves the update instant', async () => {
    const { service } = await mount()
    const first = await service.saveFromClient(httpInput())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = await service.saveFromClient(httpInput({ headers: {} }))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.createdAt).toBe(first.data.createdAt)
    expect(second.data.updatedAt >= first.data.updatedAt).toBe(true)
  })

  it('refuses the write that would exceed the account budget', async () => {
    const { service } = await mount({ maxServers: 1 })
    expect((await service.saveFromClient(httpInput())).ok).toBe(true)
    const second = await service.saveFromClient(httpInput({ name: 'other' }))
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.code).toBe('unavailable')
    expect(second.message).toContain('at most 1')
  })
})

describe('live fleet reconciliation', () => {
  it('registers an enabled definition and withdraws its tools when disabled', async () => {
    const { ctx, service } = await mount()
    await service.saveFromClient(httpInput({ name: 'live' }))
    await settled(service, 'live', 'connected')
    expect(ctx.mcpManager.list().find(view => view.name === 'live')?.configured).toBe(true)

    const disabled = await service.setEnabledFromClient('live', false)
    expect(disabled.ok).toBe(true)
    if (!disabled.ok) return
    expect(disabled.data.enabled).toBe(false)
    expect(disabled.data.status.state).toBe('disabled')
    expect(ctx.mcpManager.list().find(view => view.name === 'live')?.configured).toBeFalsy()
  })

  it('removes a definition and answers not-found afterwards', async () => {
    const { ctx, service } = await mount()
    await service.saveFromClient(httpInput({ name: 'gone' }))
    expect((await service.removeFromClient('gone')).ok).toBe(true)
    expect(ctx.mcpManager.list().some(view => view.name === 'gone')).toBe(false)
    const again = await service.removeFromClient('gone')
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.code).toBe('not_found')
  })

  it('refuses to toggle a definition that does not exist', async () => {
    const { service } = await mount()
    const result = await service.setEnabledFromClient('absent', true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('not_found')
  })

  it('survives a restart with the stored set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-verboo-mcp-restart-'))
    roots.push(root)
    const first = new Context()
    contexts.push(first)
    await first.plugin(SystemPrompt)
    await first.plugin(ToolRuntime)
    await first.plugin(MemoryCredentials)
    await first.plugin(Storage)
    await first.plugin(StorageJson, { root: join(root, 'storage') })
    await first.plugin(StorageDomain, { backend: 'json' })
    await (await first.plugin(McpServerManager, {})).await()
    await (await first.plugin(VerbooMcpServers, {})).await()
    await first.verbooMcp.saveFromClient(httpInput({ name: 'durable' }))
    await first.fiber.dispose()

    const second = new Context()
    contexts.push(second)
    await second.plugin(SystemPrompt)
    await second.plugin(ToolRuntime)
    await second.plugin(MemoryCredentials)
    await second.plugin(Storage)
    await second.plugin(StorageJson, { root: join(root, 'storage') })
    await second.plugin(StorageDomain, { backend: 'json' })
    await (await second.plugin(McpServerManager, {})).await()
    await (await second.plugin(VerbooMcpServers, {})).await()
    const listed = await second.verbooMcp.listFromClient()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.map(entry => entry.name)).toEqual(['durable'])
  })
})

describe('connection test', () => {
  it('reports advertised tools and the server identity', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'search', inputSchema: { type: 'object' } }, { name: 'read', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    const { service } = await mount()
    const signal = new AbortController().signal
    const result = await service.probeFromClient(httpInput(), signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({
      ok: true,
      stage: null,
      serverName: 'fixture',
      serverVersion: '1.0.0',
      toolNames: ['search', 'read'],
      truncated: false,
    })
    expect(typeof result.data.durationMs).toBe('number')
  })

  it('leaves the identity empty when the server advertises none', async () => {
    identity.value = undefined
    const { service } = await mount()
    const result = await service.probeFromClient(httpInput(), new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({ ok: true, serverName: null, serverVersion: null })
  })

  it('reports the failing stage instead of throwing', async () => {
    mockConnect.mockRejectedValue(new Error('connection refused'))
    const { service } = await mount()
    const result = await service.probeFromClient(httpInput(), new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.ok).toBe(false)
    expect(result.data.stage).toBe('connect')
    expect(result.data.message).toContain('connection refused')
  })

  it('refuses an invalid definition before connecting', async () => {
    const { service } = await mount()
    const result = await service.probeFromClient(httpInput({ name: 'bad name' }), new AbortController().signal)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid_input')
  })

  it('uses the submitted secret without persisting it', async () => {
    const { service, credentials } = await mount()
    await service.probeFromClient(httpInput(), new AbortController().signal)
    expect(credentials.values.size).toBe(0)
    const sent = transportConfigs.find(config => typeof config.url === 'string')
    expect(sent).toBeDefined()
    expect(JSON.stringify(sent)).toContain('Bearer secret-token')
  })

  it('falls back to a stored secret when the submission is blank', async () => {
    const { service, credentials } = await mount()
    await service.saveFromClient(httpInput())
    await settled(service, 'docs', 'connected')
    credentials.values.set('VERBOO_MCP_DOCS_AUTHORIZATION', 'stored-token')
    transportConfigs.length = 0
    const probe = await service.probeFromClient(httpInput({ headers: { Authorization: '' } }), new AbortController().signal)
    expect(probe.ok).toBe(true)
    const sent = transportConfigs.filter(config => typeof config.url === 'string').at(-1)
    expect(sent).toBeDefined()
    expect(JSON.stringify(sent)).toContain('stored-token')
  })
})

describe('agent-facing summary', () => {
  it('names the blocking condition of a definition that is not connected', async () => {
    const { service } = await mount()
    await service.saveFromClient(httpInput({ name: 'offline', enabled: false }))
    const summaries = await service.summaries()
    expect(summaries.map(entry => ({ ...entry, state: 'normalized' }))).toEqual([
      {
        name: 'offline',
        transport: 'streamable-http',
        target: 'https://mcp.example.com/mcp',
        enabled: false,
        state: 'normalized',
        toolCount: 0,
        problem: '',
      },
    ])
    expect(summaries[0]?.state).toBe('disabled')
  })

  it('describes a connected definition by its live tool count', async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: 'one', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    const { service } = await mount()
    await service.saveFromClient(httpInput({ name: 'ready' }))
    await settled(service, 'ready', 'connected')
    const summaries = await service.summaries()
    const entry = summaries[0]
    expect(entry).toBeDefined()
    expect(entry?.state).toBe('connected')
    expect(entry?.toolCount).toBe(1)
    expect(entry?.problem).toBe('')
  })

  it('keeps a stdio target as the command line', async () => {
    const { service } = await mount()
    await service.saveFromClient({
      name: 'local',
      transport: 'stdio',
      url: '',
      headers: {},
      command: 'npx',
      args: ['-y', 'server'],
      env: {},
      enabled: false,
    })
    const summaries = await service.summaries()
    expect(summaries[0]?.target).toBe('npx -y server')
  })
})

describe('definition validation coverage', () => {
  const base: McpServerInput = {
    name: 'srv',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    headers: {},
    command: '',
    args: [],
    env: {},
    enabled: true,
  }
  const stdioBase: McpServerInput = {
    ...base, transport: 'stdio', url: '', command: 'node',
  }

  it.each([
    ['more headers than the bound', { ...base, headers: Object.fromEntries(Array.from({ length: 33 }, (_v, i) => [`K${String(i)}`, 'v'])) }],
    ['an invalid header key', { ...base, headers: { 'bad key': 'v' } }],
    ['more environment entries than the bound', { ...stdioBase, env: Object.fromEntries(Array.from({ length: 33 }, (_v, i) => [`K${String(i)}`, 'v'])) }],
    ['an invalid environment key', { ...stdioBase, env: { 'bad key': 'v' } }],
    ['more arguments than the bound', { ...stdioBase, args: Array.from({ length: 65 }, () => 'a') }],
    ['an oversized argument', { ...stdioBase, args: ['x'.repeat(9000)] }],
    ['a malformed environment template', { ...stdioBase, env: { A: '${x${credential:B}' } }],
    ['a relative endpoint', { ...base, url: '/mcp' }],
    ['an endpoint on a stdio server', { ...stdioBase, url: 'https://mcp.example.com/mcp' }],
    ['a command on an http server', { ...base, command: 'node' }],
    ['arguments on an http server', { ...base, args: ['-y'] }],
    ['environment on an http server', { ...base, env: { A: 'b' } }],
  ])('refuses %s', async (_label, input) => {
    const { service } = await mount()
    const result = await service.saveFromClient(input)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('invalid_input')
  })

  it('keeps a whole credential template the surface submitted verbatim', async () => {
    const { service, credentials } = await mount()
    const result = await service.saveFromClient({
      ...base,
      headers: { Authorization: '${credential:MY_OWN_REF}' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The definition names the surface's own reference and stores no value for it.
    expect(result.data.credentialRefs).toEqual(['MY_OWN_REF'])
    expect(credentials.values.size).toBe(0)
    const probe = await service.probeFromClient(
      { ...base, headers: { Authorization: '${credential:MY_OWN_REF}' } },
      new AbortController().signal,
    )
    expect(probe.ok).toBe(true)
  })

  it('accepts a stdio definition with a valid environment key', async () => {
    const { service, credentials } = await mount()
    const result = await service.saveFromClient({
      ...stdioBase,
      env: { 'MY.TOKEN-1': 'v' },
    })
    expect(result.ok).toBe(true)
    expect(credentials.values.get('VERBOO_MCP_SRV_MY_TOKEN_1')).toBe('v')
  })
})

describe('live state mapping', () => {
  /** Present one manager status through the service's own read path. */
  async function viewOf(status: unknown) {
    const { ctx, service } = await mount()
    await service.saveFromClient(httpInput({ name: 'mapped' }))
    vi.spyOn(ctx.mcpManager, 'list').mockReturnValue([
      { name: 'mapped', configured: true, status },
    ] as never)
    const listed = await service.listFromClient()
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error('read failed')
    return listed.data[0]!.status
  }

  it.each([
    ['reconnecting', { state: 'reconnecting', attempt: 2, maxAttempts: 5, nextRetryAtMs: 1, lastError: 'lost' }, { state: 'reconnecting', toolCount: 0, lastError: 'lost' }],
    ['waiting-credentials', { state: 'waiting-credentials', lastError: 'missing' }, { state: 'waiting-credentials', toolCount: 0, lastError: 'missing' }],
    ['disabled', { state: 'disabled' }, { state: 'disabled', toolCount: 0, lastError: '' }],
    ['gave-up failure', { state: 'failed', reason: 'gave-up', lastError: 'boom' }, { state: 'failed', toolCount: 0, lastError: 'boom' }],
    ['cleanup failure', { state: 'failed', reason: 'cleanup', result: { closeConfirmed: false } }, { state: 'failed', toolCount: 0, lastError: 'cleanup is incomplete' }],
    ['closed', { state: 'closed', result: { closeConfirmed: true } }, { state: 'unknown', toolCount: 0, lastError: '' }],
  ] as const)('maps %s', async (_label, status, expected) => {
    expect(await viewOf(status)).toMatchObject(expected)
  })

  it('reports an unknown state when the manager has no record yet', async () => {
    const { ctx, service } = await mount()
    await service.saveFromClient(httpInput({ name: 'untracked' }))
    vi.spyOn(ctx.mcpManager, 'list').mockReturnValue([])
    const listed = await service.listFromClient()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data[0]?.status.state).toBe('unknown')
  })
})

describe('agent-facing diagnostics', () => {
  /** Summary text for one manager status. */
  async function problemFor(status: unknown, enabled = true) {
    const { ctx, service } = await mount()
    await service.saveFromClient(httpInput({ name: 'diag', enabled }))
    vi.spyOn(ctx.mcpManager, 'list').mockReturnValue([
      { name: 'diag', configured: true, status },
    ] as never)
    const summaries = await service.summaries()
    return summaries[0]?.problem
  }

  it.each([
    ['missing values without names', { state: 'waiting-credentials', lastError: '' }, 'a credential value is missing'],
    ['a bare startup failure', { state: 'failed', reason: 'gave-up' }, 'the server failed to start; check the definition'],
    ['a named startup failure', { state: 'failed', reason: 'gave-up', lastError: 'bad command' }, 'bad command'],
    ['a switched-off server', { state: 'disabled' }, 'the server is switched off'],
    ['a server still connecting', { state: 'connecting', attempt: 0 }, 'the server is connecting'],
  ] as const)('explains %s', async (_label, status, expected) => {
    const { ctx, service } = await mount()
    await service.saveFromClient(httpInput({ name: 'diag' }))
    vi.spyOn(ctx.mcpManager, 'list').mockReturnValue([
      { name: 'diag', configured: true, status },
    ] as never)
    const summaries = await service.summaries()
    expect(summaries[0]?.problem).toBe(expected)
  })

  it('names every missing credential reference', async () => {
    const { ctx, service, credentials } = await mount()
    await service.saveFromClient(httpInput({
      name: 'named',
      headers: { Authorization: 'a', 'X-Api-Key': 'b' },
    }))
    vi.spyOn(ctx.mcpManager, 'list').mockReturnValue([
      { name: 'named', configured: true, status: { state: 'waiting-credentials', lastError: '' } },
    ] as never)
    credentials.values.clear()
    const summaries = await service.summaries()
    expect(summaries[0]?.problem).toBe(
      'missing credential values: VERBOO_MCP_NAMED_AUTHORIZATION, VERBOO_MCP_NAMED_X_API_KEY',
    )
  })

  it('reports a storage failure as a contract error', async () => {
    const { ctx, service } = await mount()
    vi.spyOn(ctx.mcpManager, 'list').mockImplementation(() => {
      throw new Error('manager unavailable')
    })
    const listed = await service.listFromClient()
    expect(listed).toEqual({
      ok: false,
      code: 'contract_error',
      message: 'manager unavailable',
    })
  })

  it('leaves a disconnected definition without a problem line', async () => {
    expect(await problemFor({ state: 'connected', toolCount: 0 }, false)).toBe('')
  })

  it('names the live tool count of a connected definition', async () => {
    const { ctx, service } = await mount()
    await service.saveFromClient(httpInput({ name: 'counted' }))
    vi.spyOn(ctx.mcpManager, 'list').mockReturnValue([
      { name: 'counted', configured: true, status: { state: 'connected', toolCount: 7, connectedAt: 1 } },
    ] as never)
    const summaries = await service.summaries()
    expect(summaries[0]).toMatchObject({ state: 'connected', toolCount: 7, problem: '' })
  })
})

describe('definition store failures', () => {
  it('reports the open failure and answers every read as a contract error', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials)
    ctx.provide('storageDomain', {
      open: async () => { throw new Error('storage unavailable') },
    } as never)
    ctx.provide('mcpManager', { list: () => [], register: () => () => undefined } as never)
    await ctx.plugin(VerbooMcpServers, {}).await()
    const listed = await ctx.verbooMcp.listFromClient()
    expect(listed).toEqual({ ok: false, code: 'contract_error', message: 'storage unavailable' })
  })
})

describe('mount failures', () => {
  it('keeps a definition whose name the deployment already configured', async () => {
    const { ctx, service } = await mount()
    ctx.mcpManager.register('taken', {
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      cwd: '',
      url: '',
      headers: {},
    })
    await service.saveFromClient(httpInput({ name: 'taken' }))
    const listed = await service.listFromClient()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data[0]?.name).toBe('taken')
    // The deployment's own server keeps running under that name.
    expect(ctx.mcpManager.list().find(view => view.name === 'taken')?.configured).toBe(true)
  })
})

describe('ordering and stdio transports', () => {
  it('lists definitions in name order', async () => {
    const { service } = await mount()
    await service.saveFromClient(httpInput({ name: 'zeta', enabled: false }))
    await service.saveFromClient(httpInput({ name: 'alpha', enabled: false }))
    const listed = await service.listFromClient()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.map(entry => entry.name)).toEqual(['alpha', 'zeta'])
  })

  it('tests a stdio definition and passes its environment through', async () => {
    const { service } = await mount()
    const probe = await service.probeFromClient(
      {
        name: 'local-probe',
        transport: 'stdio',
        url: '',
        headers: {},
        command: 'npx',
        args: ['-y', 'server'],
        env: { TOKEN: 'local-secret' },
        enabled: false,
      },
      new AbortController().signal,
    )
    expect(probe.ok).toBe(true)
    if (!probe.ok) return
    expect(probe.data.ok).toBe(true)
    const sent = transportConfigs.filter(config => typeof config.command === 'string').at(-1)
    expect(JSON.stringify(sent)).toContain('local-secret')
  })

  it('withdraws a server whose stored definition was switched off elsewhere', async () => {
    const { ctx, service } = await mount()
    await service.saveFromClient(httpInput({ name: 'external' }))
    await settled(service, 'external', 'connected')
    const domain = ctx.storageDomain.get('verboo_mcp_servers')!
    const stored = domain.table('servers').get('external')!
    await domain.table('servers').put('external', { ...stored, enabled: false })
    await service.reconcile()
    // The manager unmounts on its own queue, so wait for the withdrawal to settle.
    for (let attempt = 0; attempt < 50 && ctx.mcpManager.list().some(view => view.name === 'external'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(ctx.mcpManager.list().some(view => view.name === 'external')).toBe(false)
    const listed = await service.listFromClient()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data[0]?.status.state).toBe('disabled')
  })

  it('contains a mount that throws and keeps the definition listed', async () => {
    const { ctx, service } = await mount()
    await service.saveFromClient(httpInput({ name: 'refused' }))
    vi.spyOn(ctx.mcpManager, 'register').mockImplementation(() => {
      throw new Error('already registered')
    })
    await service.saveFromClient(httpInput({ name: 'other' }))
    const listed = await service.listFromClient()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.map(entry => entry.name)).toEqual(['other', 'refused'])
  })
})

describe('credential withdrawal', () => {
  it('removes the stored secrets when a server is removed', async () => {
    const { service, credentials } = await mount()
    await service.saveFromClient(httpInput({ name: 'owned', headers: { Authorization: 'secret-value' } }))
    expect(credentials.values.get('VERBOO_MCP_OWNED_AUTHORIZATION')).toBe('secret-value')
    await service.removeFromClient('owned')
    expect(credentials.values.has('VERBOO_MCP_OWNED_AUTHORIZATION')).toBe(false)
  })

  it('removes only the reference an edit dropped', async () => {
    const { service, credentials } = await mount()
    await service.saveFromClient(httpInput({
      name: 'edited',
      headers: { Authorization: 'a', 'X-Api-Key': 'b' },
    }))
    await service.saveFromClient(httpInput({ name: 'edited', headers: { Authorization: 'a' } }))
    expect(credentials.values.has('VERBOO_MCP_EDITED_AUTHORIZATION')).toBe(true)
    expect(credentials.values.has('VERBOO_MCP_EDITED_X_API_KEY')).toBe(false)
  })

  it('keeps the removal even when withdrawing a secret fails', async () => {
    const { ctx, service, credentials } = await mount()
    const warn = vi.spyOn(ctx.logger, 'warn')
    await service.saveFromClient(httpInput({ name: 'stubborn', headers: { Authorization: 'a' } }))
    vi.spyOn(credentials, 'unset').mockRejectedValue(new Error('vault locked'))
    const removed = await service.removeFromClient('stubborn')
    expect(removed.ok).toBe(true)
    const listed = await service.listFromClient()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('withdrawing the credential of "stubborn" failed'),
    )
  })
})
