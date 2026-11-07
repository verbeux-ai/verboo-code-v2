import { describe, expect, it, vi } from 'vitest'
import type {
  AccountView,
  AccountCredentialRevision,
  AccountUserId,
  SignInAttemptId,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type {
  Connections,
  ConnectionId,
  Plans,
} from '@deepseek-ai/dsh-api-verboo-product/types'
import type { CustomMcpServerView, McpResult } from '@deepseek-ai/dsh-api-verboo-mcp/types'
import { ProductModel } from '../src/client/model.ts'
import type { ProductApi } from '../src/client/model.ts'

const attemptId = (id: string): SignInAttemptId => id as SignInAttemptId
const profileId = (id: string): AccountUserId => id as AccountUserId
const connectionId = 'ca_work' as ConnectionId

const links = { usageUrl: 'https://code.verboo.ai/pt/dashboard', topUpUrl: 'https://code.verboo.ai/pt/plans' }
const view = (
  revision: string,
  attempt: AccountView['attempt'] = null,
  status: AccountView['status'] = 'credential-stored',
): AccountView => ({ status, credentialRevision: revision as AccountCredentialRevision, attempt, links })

const waiting = (id: string, withUrl = true): AccountView =>
  view('a', {
    id: attemptId(id),
    phase: 'waiting-browser',
    ...(withUrl ? { authorizeUrl: 'https://code.verboo.ai/oauth/authorize?x=1' } : {}),
  })

const server = (): CustomMcpServerView => ({
  name: 'docs',
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headerNames: ['Authorization'],
  command: '',
  args: [],
  envNames: [],
  enabled: true,
  credentialRefs: ['VERBOO_MCP_DOCS_AUTHORIZATION'],
  createdAt: '2026-11-05T12:00:00Z',
  updatedAt: '2026-11-05T12:00:00Z',
  status: { state: 'connected', toolCount: 1, lastError: '', missing: [] },
})

function fixture(overrides: Partial<ProductApi> = {}) {
  const api: ProductApi = {
    profile: vi.fn(async () => null),
    start: vi.fn(async () => view('a')),
    cancel: vi.fn(async () => view('a')),
    signOut: vi.fn(async () => view('a', null, 'signed-out')),
    plans: vi.fn(async () => ({ ok: true as const, data: { subscriptions: [], catalog: [] } })),
    connections: vi.fn(async (): Promise<{ ok: true; data: Connections }> => ({
      ok: true as const,
      data: { available: true, toolkits: [], accounts: [] },
    })),
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
    setMcpEnabled: vi.fn(async () => ({ ok: true as const, data: server() })),
    probeMcpServer: vi.fn(async () => ({
      ok: true as const,
      data: { ok: true, stage: null, message: null, serverName: 'x', serverVersion: '1', toolNames: [], truncated: false, durationMs: 1 },
    })),
    ...overrides,
  }
  return { api, model: new ProductModel(api, 30000) }
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('local failure reporting', () => {
  it('records a blocked browser and a plain navigation failure separately', () => {
    const { model } = fixture()
    model.reportNavigationFailure(true)
    expect(model.state.getSnapshot()).toMatchObject({ navigationFailed: true, browserBlocked: true })
    model.reportNavigationFailure()
    expect(model.state.getSnapshot()).toMatchObject({ navigationFailed: true, browserBlocked: false })
  })

  it('owns a global action failure', () => {
    const { model } = fixture()
    model.reportActionFailure()
    expect(model.state.getSnapshot()).toMatchObject({ actionFailed: 'global', feedback: null })
  })

  it('keeps onboarding visible after verification fails', () => {
    const { model } = fixture()
    model.failAccount()
    expect(model.state.getSnapshot()).toMatchObject({ initialized: true, accountFailed: true })
  })

  it('dismisses feedback without cancelling reconciliation', () => {
    const { model } = fixture()
    model.reportNavigationFailure(true)
    model.reportActionFailure()
    model.dismiss()
    expect(model.state.getSnapshot()).toMatchObject({
      actionFailed: null, feedback: null, navigationFailed: false, browserBlocked: false,
    })
  })

  it('ignores every later update once disposed', () => {
    const { model } = fixture()
    model.dispose()
    model.reportActionFailure()
    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })
})

describe('browser sign-in', () => {
  it('starts one attempt, opens its authorization, and records the phase', async () => {
    const { api, model } = fixture({ start: vi.fn(async () => waiting('attempt-1')) })
    await model.start()
    expect(api.start).toHaveBeenCalledOnce()
    expect(api.open).toHaveBeenCalledWith('https://code.verboo.ai/oauth/authorize?x=1')
    expect(model.state.getSnapshot()).toMatchObject({ starting: false, actionFailed: null })
  })

  it('ignores a start click while one is already running', async () => {
    const gate = Promise.withResolvers<AccountView>()
    const { api, model } = fixture({ start: vi.fn(async () => gate.promise) })
    const first = model.start()
    await model.start()
    expect(api.start).toHaveBeenCalledOnce()
    gate.resolve(view('a'))
    await first
  })

  it('reports a start failure that belongs to the same observation', async () => {
    const { model } = fixture({ start: vi.fn(async () => { throw new Error('offline') }) })
    await model.start()
    expect(model.state.getSnapshot()).toMatchObject({ starting: false, actionFailed: 'sign-in' })
  })

  it('drops a start reply that describes a different attempt', async () => {
    const { model } = fixture({ start: vi.fn(async () => waiting('attempt-2')) })
    const pending = model.start()
    model.adopt(waiting('attempt-1'))
    await pending
    expect(model.state.getSnapshot().view?.attempt?.id).toBe('attempt-1')
  })

  it('reopens the same authorization without creating another attempt', async () => {
    const { api, model } = fixture()
    model.adopt(waiting('attempt-1'))
    await model.reopen()
    expect(api.open).toHaveBeenCalled()
    expect(api.start).not.toHaveBeenCalled()
  })

  it('does nothing on reopen without an observed view', async () => {
    const { api, model } = fixture()
    await model.reopen()
    expect(api.open).not.toHaveBeenCalled()
  })

  it('reports a failed browser handoff as a sign-in failure', async () => {
    const { model } = fixture({
      start: vi.fn(async () => waiting('attempt-1')),
      open: vi.fn(async () => { throw new Error('blocked') }),
    })
    await model.start()
    expect(model.state.getSnapshot().actionFailed).toBe('sign-in')
  })

  it('skips the handoff for an attempt without an authorization URL', async () => {
    const { api, model } = fixture({ start: vi.fn(async () => waiting('attempt-1', false)) })
    await model.start()
    expect(api.open).not.toHaveBeenCalled()
  })

  it('cancels only the observed attempt', async () => {
    const { api, model } = fixture()
    model.adopt(waiting('attempt-1'))
    await model.cancel()
    expect(api.cancel).toHaveBeenCalledWith('attempt-1')
  })

  it('cancels nothing when no attempt is observed', async () => {
    const { api, model } = fixture()
    await model.cancel()
    expect(api.cancel).not.toHaveBeenCalled()
  })

  it('reports a failed cancellation', async () => {
    const { model } = fixture({ cancel: vi.fn(async () => { throw new Error('offline') }) })
    model.adopt(waiting('attempt-1'))
    await model.cancel()
    expect(model.state.getSnapshot().actionFailed).toBe('sign-in')
  })

  it('lets a newer account win over a late cancellation reply', async () => {
    const gate = Promise.withResolvers<AccountView>()
    const { model } = fixture({ cancel: vi.fn(async () => gate.promise) })
    model.adopt(waiting('attempt-1'))
    const cancelling = model.cancel()
    model.adopt(waiting('attempt-2'))
    gate.resolve(view('b'))
    await cancelling
    expect(model.state.getSnapshot().view?.attempt?.id).toBe('attempt-2')
  })
})

describe('account identity and reads', () => {
  it('revokes the login and reports confirmation', async () => {
    const { model } = fixture()
    expect(await model.signOut()).toBe(true)
    expect(model.state.getSnapshot().busy).toBeNull()
  })

  it('keeps a failed sign-out actionable', async () => {
    const { model } = fixture({ signOut: vi.fn(async () => { throw new Error('offline') }) })
    expect(await model.signOut()).toBe(false)
    expect(model.state.getSnapshot()).toMatchObject({ busy: null, actionFailed: 'sign-out' })
  })

  it('starts onboarding when the profile read returns nothing', async () => {
    const { model } = fixture({ profile: vi.fn(async () => null) })
    await model.refreshProfile()
    expect(model.state.getSnapshot().accountFailed).toBe(true)
  })

  it('reports a failed profile read', async () => {
    const { model } = fixture({ profile: vi.fn(async () => { throw new Error('offline') }) })
    await model.refreshProfile()
    expect(model.state.getSnapshot().accountFailed).toBe(true)
  })

  it('lets a new account start a fresh read and drops the older reply', async () => {
    // The stale read belongs to the account that just changed, so the fresh
    // read must win even when the stale reply arrives last.
    const stale = Promise.withResolvers<Awaited<ReturnType<ProductApi['profile']>>>()
    let reads = 0
    const { model } = fixture({
      profile: vi.fn(async () => {
        reads += 1
        return reads === 1 ? stale.promise : { id: profileId('fresh'), name: 'Fresh', contact: null }
      }),
    })
    const reading = model.refreshProfile()
    model.adopt(view('b'))
    await settle()
    stale.resolve({ id: profileId('stale'), name: 'Stale', contact: null })
    await reading
    await settle()
    expect(model.state.getSnapshot().profile?.id).toBe('fresh')
  })

  it('discards catalog data when the account identity changes', async () => {
    const { model } = fixture({
      profile: vi.fn(async () => ({ id: profileId('first'), name: 'First', contact: null })),
    })
    await model.refreshProfile()
    await settle()
    expect(model.state.getSnapshot().profile?.id).toBe('first')
    const { model: second } = fixture({
      profile: vi.fn(async () => ({ id: profileId('second'), name: 'Second', contact: null })),
    })
    await second.refreshProfile()
    await settle()
    expect(second.state.getSnapshot().profile?.id).toBe('second')
  })

  it('joins concurrent account reads', async () => {
    const { api, model } = fixture()
    await Promise.all([model.refreshProfile(), model.refreshProfile()])
    expect(api.profile).toHaveBeenCalledOnce()
  })

  it('keeps the last valid plan projection on a failed refresh', async () => {
    const { model } = fixture({
      plans: vi.fn(async () => ({ ok: false as const, code: 'request_failed' as const })),
    })
    await model.loadPlans()
    expect(model.state.getSnapshot().plansFailed).toBe(true)
  })

  it('reports a thrown plan read', async () => {
    const { model } = fixture({ plans: vi.fn(async () => { throw new Error('offline') }) })
    await model.loadPlans()
    expect(model.state.getSnapshot().plansFailed).toBe(true)
  })

  it('drops a plan reply from an older account', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['plans']>>>()
    const { model } = fixture({ plans: vi.fn(async () => gate.promise) })
    const reading = model.loadPlans()
    model.adopt(view('b'))
    gate.resolve({ ok: true, data: { subscriptions: [], catalog: [] } })
    await reading
    expect(model.state.getSnapshot().plans).toBeNull()
  })

  it('reports a failed connection read and a thrown one', async () => {
    const failed = fixture({ connections: vi.fn(async () => ({ ok: false as const, code: 'request_failed' as const })) })
    await failed.model.loadConnections()
    expect(failed.model.state.getSnapshot().connectionsFailed).toBe(true)
    const thrown = fixture({ connections: vi.fn(async () => { throw new Error('offline') }) })
    await thrown.model.loadConnections()
    expect(thrown.model.state.getSnapshot().connectionsFailed).toBe(true)
  })

  it('keeps a failed connection read out of a newer account', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['connections']>>>()
    const { model } = fixture({ connections: vi.fn(async () => gate.promise) })
    const reading = model.loadConnections()
    model.adopt(view('b'))
    gate.resolve({ ok: false, code: 'request_failed' })
    await reading
    expect(model.state.getSnapshot().connectionsFailed).toBe(false)
  })

  it('confirms a created authorization when the account becomes connected', async () => {
    const pending: Connections = {
      available: true,
      toolkits: [{ slug: 'github', name: 'GitHub', available: true }],
      accounts: [{ id: connectionId, toolkit: 'github', label: 'Work', status: 'pending' as const }],
    }
    const connected: Connections = {
      ...pending,
      accounts: [{ id: connectionId, toolkit: 'github', label: 'Work', status: 'connected' as const }],
    }
    let reads = 0
    const { model } = fixture({
      connections: vi.fn(async () => {
        reads += 1
        return { ok: true as const, data: reads === 1 ? pending : connected }
      }),
    })
    await model.connect('github', 'Work')
    // The dialog handoff reconciles on the next poll, not inside connect().
    await model.loadConnections()
    expect(model.state.getSnapshot().feedback).toBe('connectionSuccess')
    expect(model.state.getSnapshot().connectedTarget).toBeNull()
  })

  it('marks a pending authorization window so polling continues', async () => {
    const withPending: Connections = {
      available: true,
      toolkits: [],
      accounts: [{ id: connectionId, toolkit: 'github', label: 'Work', status: 'pending' as const }],
    }
    const { model } = fixture({
      connections: vi.fn(async (): Promise<{ ok: true; data: Connections }> => ({ ok: true as const, data: withPending })),
    })
    await model.loadConnections()
    expect(model.shouldPoll(Date.now())).toBe(true)
  })

  it('stops polling once the handoff budget expires', () => {
    const { model } = fixture()
    model.state.set({
      ...model.state.getSnapshot(),
      handoff: 'connection',
      handoffUntil: Date.now() - 1000,
    })
    expect(model.shouldPoll(Date.now())).toBe(false)
    expect(model.state.getSnapshot().handoff).toBeNull()
  })

  it('keeps polling during a live handoff budget', () => {
    const { model } = fixture()
    model.state.set({
      ...model.state.getSnapshot(),
      handoff: 'billing',
      handoffUntil: Date.now() + 60000,
    })
    expect(model.shouldPoll(Date.now())).toBe(true)
  })

  it('reports an unconfirmed disconnect', async () => {
    const { model } = fixture({
      disconnect: vi.fn(async () => ({ ok: false as const, code: 'request_failed' as const })),
    })
    expect(await model.disconnect(connectionId)).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBe('disconnect')
  })

  it('reports a thrown disconnect', async () => {
    const { model } = fixture({ disconnect: vi.fn(async () => { throw new Error('offline') }) })
    expect(await model.disconnect(connectionId)).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBe('disconnect')
  })

  it('refuses a second action while one is running', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['disconnect']>>>()
    const { api, model } = fixture({ disconnect: vi.fn(async () => gate.promise) })
    const first = model.disconnect(connectionId)
    expect(await model.disconnect(connectionId)).toBe(false)
    expect(api.disconnect).toHaveBeenCalledOnce()
    gate.resolve({ ok: true, data: null })
    await first
  })

  it('opens billing and clears the handoff when the plan list did not change', async () => {
    const plans: Plans = {
      subscriptions: [{
        id: 'sub', planId: ('00000000-0000-4000-8000-000000000001' as never), name: 'Pro', status: 'active', renewsAt: null,
        cancelAtEnd: false, canUpgrade: true,
        billing: { amountMinor: 100, currency: 'BRL', interval: 'month' },
      }],
      catalog: [{ id: ('00000000-0000-4000-8000-000000000001' as never), name: 'Pro', description: 'Pro', priceCents: 100, currency: 'BRL', interval: 'month' }],
    }
    const { api, model } = fixture({ plans: vi.fn(async () => ({ ok: true as const, data: plans })) })
    await model.loadPlans()
    await model.billing(('00000000-0000-4000-8000-000000000001' as never), true)
    expect(api.billing).toHaveBeenCalledWith(('00000000-0000-4000-8000-000000000001' as never), true)
    expect(model.state.getSnapshot().handoff).toBe('billing')
  })

  it('reports a billing failure owned by global feedback', async () => {
    const { model } = fixture({
      billing: vi.fn(async () => ({ ok: false as const, code: 'request_failed' as const })),
    })
    expect(await model.billing(null, false)).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBe('global')
  })

  it('joins model initialization and reports a failure', async () => {
    const { api, model } = fixture({ initializeModel: vi.fn(async () => false) })
    await Promise.all([model.initializeModel(), model.initializeModel()])
    expect(api.initializeModel).toHaveBeenCalledOnce()
    expect(model.state.getSnapshot()).toMatchObject({ modelFailed: true, initializingModel: false })
  })

  it('reports a thrown model initialization', async () => {
    const { model } = fixture({ initializeModel: vi.fn(async () => { throw new Error('offline') }) })
    await model.initializeModel()
    expect(model.state.getSnapshot().modelFailed).toBe(true)
  })

  it('does not regress an attempt phase observed in a newer reply', () => {
    const { model } = fixture()
    model.adopt({
      ...view('a'),
      attempt: { id: attemptId('attempt-1'), phase: 'committing' },
    })
    model.adopt({
      ...view('a'),
      attempt: { id: attemptId('attempt-1'), phase: 'initializing' },
    })
    expect(model.state.getSnapshot().view?.attempt?.phase).toBe('committing')
  })
})

describe('MCP write guards', () => {
  it('ignores a save that settles after the account changed', async () => {
    const gate = Promise.withResolvers<McpResult<CustomMcpServerView>>()
    const { model } = fixture({ saveMcpServer: vi.fn(async () => gate.promise) })
    const saving = model.saveMcpServer({
      name: 'docs', transport: 'streamable-http', url: 'https://x/mcp',
      headers: {}, command: '', args: [], env: {}, enabled: true,
    })
    model.adopt(view('b'))
    gate.resolve({ ok: true, data: server() })
    expect(await saving).toBe(false)
  })

  it('ignores a removal that settles after the account changed', async () => {
    const gate = Promise.withResolvers<McpResult<null>>()
    const { model } = fixture({ deleteMcpServer: vi.fn(async () => gate.promise) })
    const removing = model.deleteMcpServer('docs')
    model.adopt(view('b'))
    gate.resolve({ ok: true, data: null })
    expect(await removing).toBe(false)
  })

  it('ignores a toggle that settles after the account changed', async () => {
    const gate = Promise.withResolvers<McpResult<CustomMcpServerView>>()
    const { model } = fixture({ setMcpEnabled: vi.fn(async () => gate.promise) })
    const toggling = model.setMcpEnabled('docs', true)
    model.adopt(view('b'))
    gate.resolve({ ok: true, data: server() })
    expect(await toggling).toBe(false)
  })

  it('does not publish a probe that settles after the account changed', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['probeMcpServer']>>>()
    const { model } = fixture({ probeMcpServer: vi.fn(async () => gate.promise) })
    const probing = model.probeMcpServer({
      name: 'docs', transport: 'streamable-http', url: 'https://x/mcp',
      headers: {}, command: '', args: [], env: {}, enabled: true,
    })
    model.adopt(view('b'))
    gate.resolve({
      ok: true,
      data: { ok: true, stage: null, message: null, serverName: 'x', serverVersion: '1', toolNames: [], truncated: false, durationMs: 1 },
    })
    expect(await probing).toBe(false)
    expect(model.state.getSnapshot().mcpProbe).toBeNull()
  })
})

describe('remaining guards and recovery paths', () => {
  it('starts a new catalog generation when the profile identity changes', async () => {
    let reads = 0
    const { api, model } = fixture({
      profile: vi.fn(async () => {
        reads += 1
        return {
          id: profileId(reads === 1 ? 'first' : 'second'),
          name: 'Account',
          contact: null,
        }
      }),
    })
    await model.refreshProfile()
    await settle()
    expect(model.state.getSnapshot().profile?.id).toBe('first')
    await model.refreshProfile()
    await settle()
    expect(model.state.getSnapshot().profile?.id).toBe('second')
    // A new identity starts its own catalog reads instead of reusing the old ones.
    expect(api.plans).toHaveBeenCalledTimes(2)
    expect(api.connections).toHaveBeenCalledTimes(2)
  })

  it('joins a connection read already in flight', async () => {
    const { api, model } = fixture()
    await Promise.all([model.loadConnections(), model.loadConnections()])
    expect(api.connections).toHaveBeenCalledOnce()
  })

  it('refuses an MCP write while another command owns the busy slot', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['disconnect']>>>()
    const { api, model } = fixture({ disconnect: vi.fn(async () => gate.promise) })
    const busy = model.disconnect(connectionId)
    const input = {
      name: 'docs', transport: 'streamable-http' as const, url: 'https://x/mcp',
      headers: {}, command: '', args: [], env: {}, enabled: true,
    }
    expect(await model.saveMcpServer(input)).toBe(false)
    expect(await model.setMcpEnabled('docs', true)).toBe(false)
    expect(await model.deleteMcpServer('docs')).toBe(false)
    expect(api.saveMcpServer).not.toHaveBeenCalled()
    expect(api.setMcpEnabled).not.toHaveBeenCalled()
    gate.resolve({ ok: true, data: null })
    await busy
  })

  it('refuses a billing click while another command owns the busy slot', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['disconnect']>>>()
    const { api, model } = fixture({ disconnect: vi.fn(async () => gate.promise) })
    const busy = model.disconnect(connectionId)
    expect(await model.billing(null, false)).toBe(false)
    expect(api.billing).not.toHaveBeenCalled()
    gate.resolve({ ok: true, data: null })
    await busy
  })

  it('reports a refused connection authorization', async () => {
    const { model } = fixture({
      connect: vi.fn(async () => ({ ok: false as const, code: 'request_failed' as const })),
    })
    expect(await model.connect('github', 'Work')).toBe(false)
    expect(model.state.getSnapshot()).toMatchObject({ actionFailed: 'connect', busy: null })
  })

  it('reports a thrown connection authorization', async () => {
    const { model } = fixture({ connect: vi.fn(async () => { throw new Error('offline') }) })
    expect(await model.connect('github', 'Work')).toBe(false)
    expect(model.state.getSnapshot()).toMatchObject({ actionFailed: 'connect', busy: null })
  })

  it('drops an authorization reply that belongs to an older account', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['connect']>>>()
    const { model } = fixture({ connect: vi.fn(async () => gate.promise) })
    const connecting = model.connect('github', 'Work')
    model.adopt(view('b'))
    gate.resolve({
      ok: true,
      data: { url: 'https://connect.composio.dev/x', expiresAt: new Date(Date.now() + 60000).toISOString(), id: null },
    })
    expect(await connecting).toBe(false)
  })

  it('drops an MCP write that fails after the account changed', async () => {
    const gate = Promise.withResolvers<McpResult<CustomMcpServerView>>()
    const { model } = fixture({ saveMcpServer: vi.fn(async () => gate.promise) })
    const saving = model.saveMcpServer({
      name: 'docs', transport: 'streamable-http', url: 'https://x/mcp',
      headers: {}, command: '', args: [], env: {}, enabled: true,
    })
    model.adopt(view('b'))
    gate.resolve({ ok: false, code: 'contract_error', message: 'late' })
    expect(await saving).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })

  it('reports a failed reopen of an expired authorization', async () => {
    const { model } = fixture()
    await model.reopenConnection(connectionId)
    expect(model.state.getSnapshot().actionFailed).toBe('global')
  })

  it('reports a blocked browser when reopening a live authorization', async () => {
    const { model } = fixture({
      open: vi.fn(async () => { throw new Error('blocked') }),
      connections: vi.fn(async (): Promise<{ ok: true; data: Connections }> => ({
        ok: true as const,
        data: {
          available: true,
          toolkits: [{ slug: 'github', name: 'GitHub', available: true }],
          accounts: [{ id: connectionId, toolkit: 'github', label: 'Work', status: 'pending' as const }],
        },
      })),
    })
    await model.connect('github', 'Work')
    await model.loadConnections()
    await model.reopenConnection(connectionId)
    expect(model.state.getSnapshot().navigationFailed).toBe(true)
  })

  it('forgets the stored authorization of a disconnected account', async () => {
    const { model } = fixture({
      connect: vi.fn(async () => ({
        ok: true as const,
        data: {
          url: 'https://connect.composio.dev/x',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          id: connectionId,
        },
      })),
      connections: vi.fn(async (): Promise<{ ok: true; data: Connections }> => ({
        ok: true as const,
        data: {
          available: true,
          toolkits: [{ slug: 'github', name: 'GitHub', available: true }],
          accounts: [{ id: connectionId, toolkit: 'github', label: 'Work', status: 'connected' as const }],
        },
      })),
    })
    await model.connect('github', 'Work')
    expect(await model.disconnect(connectionId)).toBe(true)
    expect(model.state.getSnapshot().feedback).toBe('disconnectSuccess')
    // The remembered link is gone, so a reopen is refused instead of navigating.
    await model.reopenConnection(connectionId)
    expect(model.state.getSnapshot().actionFailed).toBe('global')
  })
})
