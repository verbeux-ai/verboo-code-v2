/**
 * Dynamic connection discovery: the provider's schema is projected onto the
 * enforced tool subset, and one search makes the matching actions callable in
 * the Agent's own scope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  ConnectionToolRegistry,
  connectionToolName,
  discoverConnectionTools,
  sanitizeNode,
} from '../src/discovery.ts'
import type { ConnectionProduct, DiscoveryBudgets } from '../src/discovery.ts'

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

const budgets: DiscoveryBudgets = {
  maxTools: 4,
  maxTargets: 2,
  maxSchemaBytes: 2000,
  maxDescriptionChars: 120,
  timeoutMs: 5000,
}

/** Mount a tool registry and return a registry bound to that scope. */
async function scope() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const catalog = JSON.stringify({
  available: true,
  accounts: [
    { id: 'ca_work', toolkit: 'gmail', label: 'Work', status: 'connected' },
    { id: 'ca_personal', toolkit: 'gmail', label: 'Personal', status: 'connected' },
    { id: 'ca_expired', toolkit: 'github', label: 'Old', status: 'expired' },
  ],
  publicServices: [{ id: 'public_searxng', toolkit: 'searxng', label: 'SearXNG' }],
})

const gmailSearch = {
  slug: 'GMAIL_SEARCH_EMAILS',
  name: 'Search emails',
  description: 'Find messages by query.',
  version: '20240101_00',
  parameters: {
    type: 'object',
    $schema: 'http://json-schema.org/draft-07/schema#',
    properties: { query: { type: 'string', minLength: 1, description: 'Search text.' } },
    required: ['query', 'unknown'],
    additionalProperties: false,
  },
}

describe('schema projection', () => {
  it('keeps only the enforced subset and drops upstream-only keywords', () => {
    expect(sanitizeNode(gmailSearch.parameters, 0)).toEqual({
      type: 'object',
      properties: { query: { type: 'string', description: 'Search text.' } },
      required: ['query'],
      additionalProperties: false,
    })
  })

  it('drops a required key that the property map does not declare', () => {
    const node = sanitizeNode({ type: 'object', properties: {}, required: ['missing'] }, 0)
    expect(node).not.toHaveProperty('required')
  })

  it('keeps a two-branch union and collapses a single branch to unconstrained JSON', () => {
    expect(sanitizeNode({ oneOf: [{ type: 'string' }, { type: 'null' }] }, 0)).toEqual({
      oneOf: [{ type: 'string' }, { type: 'null' }],
    })
    expect(sanitizeNode({ oneOf: [{ type: 'string', format: 'email' }] }, 0)).toEqual({})
  })

  it('keeps literal constraints that match the declared type', () => {
    expect(sanitizeNode({ type: 'string', enum: ['a', 1, null] }, 0)).toEqual({ type: 'string', enum: ['a'] })
    expect(sanitizeNode({ type: 'integer', const: 2.5 }, 0)).toEqual({ type: 'integer' })
    expect(sanitizeNode({ type: 'integer', const: 3 }, 0)).toEqual({ type: 'integer', const: 3 })
  })

  it('resolves local provider definitions and nullable arguments', () => {
    expect(sanitizeNode({
      type: 'object',
      properties: { recipient: { $ref: '#/$defs/Recipient' }, subject: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['recipient'],
      $defs: { Recipient: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } },
    }, 0)).toEqual({
      type: 'object',
      properties: {
        recipient: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
        subject: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['recipient'],
    })
  })

  it('stops constraining past the depth bound instead of recursing forever', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let level = 0; level < 20; level++) deep = { type: 'object', properties: { next: deep } }
    let node = sanitizeNode(deep, 0)
    let depth = 0
    while (typeof node === 'object' && node !== null && 'properties' in node) {
      node = (node.properties as Record<string, Record<string, unknown>>).next as Record<string, unknown>
      depth += 1
    }
    expect(depth).toBeLessThanOrEqual(13)
    expect(node).toEqual({})
  })
})

describe('tool naming', () => {
  it('names the clean case after the service and the provider slug', () => {
    expect(connectionToolName('gmail', 'GMAIL_SEARCH_EMAILS')).toBe('connection__gmail__GMAIL_SEARCH_EMAILS')
  })

  it('appends an identity hash when normalization or truncation changes the name', () => {
    const name = connectionToolName('srv', 'admin.reset')
    expect(name).toMatch(/^connection__srv__admin_reset_[a-f0-9]{12}$/)
    expect(connectionToolName('srv', 'admin-reset')).not.toBe(name)
    const long = connectionToolName('toolkit', 'x'.repeat(120))
    expect(long).toHaveLength(64)
    expect(long).toMatch(/_[a-f0-9]{12}$/)
  })
})

describe('discoverConnectionTools', () => {
  /** A product stub whose searches answer from one map. */
  function product(overrides: Partial<ConnectionProduct> = {}): ConnectionProduct {
    return {
      listAgentConnections: async () => catalog,
      searchAgentConnections: async (_id, query) =>
        JSON.stringify(query === 'missing' ? [] : [gmailSearch]),
      executeAgentConnection: async () => '{}',
      ...overrides,
    }
  }

  it('registers the matching tools and reports them as callable', async () => {
    const ctx = await scope()
    const registry = new ConnectionToolRegistry(ctx, product(), budgets)
    const outcome = await discoverConnectionTools({
      product: product(),
      registry,
      budgets,
      request: { query: 'search email', connectionId: 'ca_work' },
      signal: new AbortController().signal,
    })
    expect(outcome.tools).toEqual([{
      tool: 'connection__gmail__GMAIL_SEARCH_EMAILS',
      toolkit: 'gmail',
      account: 'Work',
      version: '20240101_00',
      status: 'added',
      description: '[gmail · Work] Search emails: Find messages by query.',
    }])
    expect(outcome.note).toContain('callable in this conversation now')
    expect(ctx.tools.get('connection__gmail__GMAIL_SEARCH_EMAILS')?.parameters).toEqual({
      type: 'object',
      properties: { query: { type: 'string', description: 'Search text.' } },
      required: ['query'],
      additionalProperties: false,
    })
  })

  it('asks the user to choose when one service has several accounts', async () => {
    const ctx = await scope()
    const registry = new ConnectionToolRegistry(ctx, product(), budgets)
    const outcome = await discoverConnectionTools({
      product: product(),
      registry,
      budgets,
      request: { query: 'search email' },
      signal: new AbortController().signal,
    })
    expect(outcome.ambiguous).toEqual([{
      toolkit: 'gmail',
      accounts: [{ id: 'ca_work', label: 'Work' }, { id: 'ca_personal', label: 'Personal' }],
    }])
    // The public no-credential service has exactly one account, so it is searched.
    expect(outcome.tools.map(tool => tool.toolkit)).toEqual(['searxng'])
    expect(outcome.note).toContain('ask the user which account')
  })

  it('searches the account the user named', async () => {
    const ctx = await scope()
    const registry = new ConnectionToolRegistry(ctx, product(), budgets)
    const outcome = await discoverConnectionTools({
      product: product(),
      registry,
      budgets,
      request: { query: 'search email', connectionId: 'ca_personal' },
      signal: new AbortController().signal,
    })
    expect(outcome.tools.map(tool => tool.account)).toEqual(['Personal'])
    expect(outcome.ambiguous).toEqual([])
  })

  it('searches connected accounts before public services and does not mistake a public service for another account', async () => {
    const ctx = await scope()
    const listing = JSON.stringify({
      available: true,
      accounts: [{ id: 'ca_work', toolkit: 'gmail', label: 'Work', status: 'connected' }],
      publicServices: [
        ...Array.from({ length: 5 }, (_, index) => ({ id: `public_s${index}`, toolkit: `s${index}`, label: `Service ${index}` })),
        { id: 'public_gmail', toolkit: 'gmail', label: 'Gmail' },
      ],
    })
    const search = vi.fn(async (_id: string, _query: string, _signal: AbortSignal) => JSON.stringify([gmailSearch]))
    const stub = product({ listAgentConnections: async () => listing, searchAgentConnections: search })
    const registry = new ConnectionToolRegistry(ctx, stub, budgets)
    const outcome = await discoverConnectionTools({
      product: stub, registry, budgets, request: { query: 'find and reply to an email' }, signal: new AbortController().signal,
    })
    expect(search.mock.calls.map(call => call[0])).toEqual(['ca_work', 'public_s0'])
    expect(outcome.tools[0]?.account).toBe('Work')
    expect(outcome.ambiguous).toEqual([])
    expect(outcome.notSearched).toEqual(['s1', 's2', 's3', 's4'])
  })

  it('refuses an account the listing does not offer', async () => {
    const ctx = await scope()
    const registry = new ConnectionToolRegistry(ctx, product(), budgets)
    await expect(discoverConnectionTools({
      product: product(),
      registry,
      budgets,
      request: { query: 'search email', connectionId: 'ca_expired' },
      signal: new AbortController().signal,
    })).rejects.toThrow('that connection is not available')
  })

  it('reports a failed search without leaking the provider body', async () => {
    const ctx = await scope()
    const failing = product({
      searchAgentConnections: async () => {
        throw Object.assign(new Error('upstream body'), { code: 'unavailable' })
      },
    })
    const registry = new ConnectionToolRegistry(ctx, failing, budgets)
    const outcome = await discoverConnectionTools({
      product: failing,
      registry,
      budgets,
      request: { query: 'search email', toolkit: 'searxng' },
      signal: new AbortController().signal,
    })
    expect(outcome.tools).toEqual([])
    expect(outcome.failed).toEqual([{ toolkit: 'searxng', connectionId: 'public_searxng', code: 'unavailable' }])
    expect(JSON.stringify(outcome)).not.toContain('upstream body')
  })

  it('never reuses one name for another account', async () => {
    const ctx = await scope()
    const registry = new ConnectionToolRegistry(ctx, product(), budgets)
    const signal = new AbortController().signal
    const first = await discoverConnectionTools({
      product: product(), registry, budgets, request: { query: 'search email', connectionId: 'ca_work' }, signal,
    })
    const second = await discoverConnectionTools({
      product: product(), registry, budgets, request: { query: 'search email', connectionId: 'ca_personal' }, signal,
    })
    expect(first.tools[0]?.tool).toBe('connection__gmail__GMAIL_SEARCH_EMAILS')
    expect(second.tools[0]?.tool).toMatch(/^connection__gmail__GMAIL_SEARCH_EMAILS_[a-f0-9]{8}$/)
    expect(second.tools[0]?.account).toBe('Personal')
  })

  it('replaces an older provider version instead of duplicating the tool', async () => {
    const ctx = await scope()
    const newer = { ...gmailSearch, version: '20240202_00' }
    const registry = new ConnectionToolRegistry(ctx, product(), budgets)
    const signal = new AbortController().signal
    const first = await discoverConnectionTools({
      product: product(), registry, budgets, request: { query: 'search email', connectionId: 'ca_work' }, signal,
    })
    const second = await discoverConnectionTools({
      product: product({ searchAgentConnections: async () => JSON.stringify([newer]) }),
      registry,
      budgets,
      request: { query: 'search email', connectionId: 'ca_work' },
      signal,
    })
    expect(first.tools[0]?.status).toBe('added')
    expect(second.tools[0]?.status).toBe('updated')
    expect(second.tools[0]?.version).toBe('20240202_00')
    expect(ctx.tools.get('connection__gmail__GMAIL_SEARCH_EMAILS')).toBeDefined()
  })

  it('bounds one search to its tool budget', async () => {
    const ctx = await scope()
    const many = Array.from({ length: 6 }, (_entry, index) => ({
      ...gmailSearch,
      slug: `GMAIL_TOOL_${String(index)}`,
    }))
    const registry = new ConnectionToolRegistry(ctx, product({
      searchAgentConnections: async () => JSON.stringify(many),
    }), budgets)
    const outcome = await discoverConnectionTools({
      product: product({ searchAgentConnections: async () => JSON.stringify(many) }),
      registry,
      budgets,
      request: { query: 'search email', connectionId: 'ca_work' },
      signal: new AbortController().signal,
    })
    expect(outcome.tools).toHaveLength(budgets.maxTools)
  })

  it('declares unconstrained arguments when a schema exceeds the byte budget', async () => {
    const ctx = await scope()
    const huge = {
      ...gmailSearch,
      slug: 'GMAIL_HUGE',
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Array.from({ length: 200 }, (_entry, index) => [
          `field${String(index)}`,
          { type: 'string', description: 'x'.repeat(60) },
        ])),
      },
    }
    const registry = new ConnectionToolRegistry(ctx, product({
      searchAgentConnections: async () => JSON.stringify([huge]),
    }), budgets)
    await discoverConnectionTools({
      product: product({ searchAgentConnections: async () => JSON.stringify([huge]) }),
      registry,
      budgets,
      request: { query: 'search email', connectionId: 'ca_work' },
      signal: new AbortController().signal,
    })
    expect(ctx.tools.get('connection__gmail__GMAIL_HUGE')?.parameters).toEqual({})
  })

  it('counts multibyte text against the schema byte budget', async () => {
    const ctx = await scope()
    const smallBudget = { ...budgets, maxSchemaBytes: 100 }
    const stub = product()
    const registry = new ConnectionToolRegistry(ctx, stub, smallBudget)
    registry.install({ id: 'ca_work', toolkit: 'gmail', label: 'Work' }, {
      ...gmailSearch,
      parameters: { type: 'object', properties: { ['é'.repeat(40)]: { type: 'string' } } },
    })
    expect(ctx.tools.get('connection__gmail__GMAIL_SEARCH_EMAILS')?.parameters).toEqual({})
  })

  it('keeps argument names and requirements when descriptions exceed the budget', async () => {
    const ctx = await scope()
    const smallBudget = { ...budgets, maxSchemaBytes: 180 }
    const registry = new ConnectionToolRegistry(ctx, product(), smallBudget)
    registry.install({ id: 'ca_work', toolkit: 'gmail', label: 'Work' }, {
      ...gmailSearch,
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'x'.repeat(300) } }, required: ['query'] },
    })
    expect(ctx.tools.get('connection__gmail__GMAIL_SEARCH_EMAILS')?.parameters).toEqual({
      type: 'object', properties: { query: { type: 'string' } }, required: ['query'],
    })
  })

  it('does not register tools after a search is cancelled', async () => {
    const ctx = await scope()
    const controller = new AbortController()
    const stub = product({ searchAgentConnections: async () => {
      controller.abort()
      return JSON.stringify([gmailSearch])
    } })
    const registry = new ConnectionToolRegistry(ctx, stub, budgets)
    await expect(discoverConnectionTools({
      product: stub, registry, budgets, request: { query: 'search email', connectionId: 'ca_work' }, signal: controller.signal,
    })).rejects.toThrow()
    expect(ctx.tools.get('connection__gmail__GMAIL_SEARCH_EMAILS')).toBeUndefined()
  })

  it('executes a registered tool against its own account and pinned version', async () => {
    const ctx = await scope()
    const execute = vi.fn(async () => '{"ok":true}')
    const stub = product({ executeAgentConnection: execute })
    const registry = new ConnectionToolRegistry(ctx, stub, budgets)
    await discoverConnectionTools({
      product: stub,
      registry,
      budgets,
      request: { query: 'search email', connectionId: 'ca_work' },
      signal: new AbortController().signal,
    })
    const definition = ctx.tools.get('connection__gmail__GMAIL_SEARCH_EMAILS')
    const value = await definition?.execute({ query: 'from:ana' }, {
      callId: 'call-1',
      token: 'token-1',
      name: 'connection__gmail__GMAIL_SEARCH_EMAILS',
      arguments: { query: 'from:ana' },
      signal: new AbortController().signal,
      deferContext: () => undefined,
    } as never)
    expect(value).toBe('{"ok":true}')
    expect(execute).toHaveBeenCalledWith(
      { connectionId: 'ca_work', slug: 'GMAIL_SEARCH_EMAILS', version: '20240101_00', arguments: { query: 'from:ana' } },
      expect.any(AbortSignal),
    )
  })

  it('withdraws every tool it registered', async () => {
    const ctx = await scope()
    const registry = new ConnectionToolRegistry(ctx, product(), budgets)
    await discoverConnectionTools({
      product: product(),
      registry,
      budgets,
      request: { query: 'search email', connectionId: 'ca_work' },
      signal: new AbortController().signal,
    })
    expect(ctx.tools.get('connection__gmail__GMAIL_SEARCH_EMAILS')).toBeDefined()
    registry.dispose()
    expect(ctx.tools.get('connection__gmail__GMAIL_SEARCH_EMAILS')).toBeUndefined()
  })
})
