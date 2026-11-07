import { describe, expect, it, vi } from 'vitest'
import type {
  AccountView,
  AccountCredentialRevision,
  AccountUserId,
  SignInAttemptId,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type {
  ConnectionId,
  PlanId,
  Plans,
} from '@deepseek-ai/dsh-api-verboo-product/types'
import type { CustomMcpServerView, McpResult, McpServerProbe } from '@deepseek-ai/dsh-api-verboo-mcp/types'
import { ProductModel } from '../src/client/model.ts'
import type { ProductApi } from '../src/client/model.ts'

const attemptId = (id: string): SignInAttemptId => id as SignInAttemptId
const profileId = (id: string): AccountUserId => id as AccountUserId
const planId = '00000000-0000-4000-8000-000000000001' as PlanId
const connectionId = 'ca_work' as ConnectionId
const links = { usageUrl: 'u', topUpUrl: 't' }

const view = (
  revision: string,
  attempt: AccountView['attempt'] = null,
  status: AccountView['status'] = 'credential-stored',
): AccountView => ({ status, credentialRevision: revision as AccountCredentialRevision, attempt, links })

const waiting = (id: string): AccountView =>
  view('a', { id: attemptId(id), phase: 'waiting-browser', authorizeUrl: 'https://code.verboo.ai/oauth/authorize' })

const server = (): CustomMcpServerView => ({
  name: 'docs', transport: 'streamable-http', url: 'https://x/mcp',
  headerNames: [], command: '', args: [], envNames: [], enabled: true,
  credentialRefs: [], createdAt: '2026-11-05T12:00:00Z', updatedAt: '2026-11-05T12:00:00Z',
  status: { state: 'connected', toolCount: 1, lastError: '', missing: [] },
})

const mcpInput = {
  name: 'docs', transport: 'streamable-http' as const, url: 'https://x/mcp',
  headers: {}, command: '', args: [], env: {}, enabled: true,
}

const probeData: McpServerProbe = {
  ok: true, stage: null, message: null, serverName: 'x', serverVersion: '1',
  toolNames: [], truncated: false, durationMs: 1,
}

function fixture(overrides: Partial<ProductApi> = {}) {
  const api: ProductApi = {
    profile: vi.fn(async () => null),
    start: vi.fn(async () => view('a')),
    cancel: vi.fn(async () => view('a')),
    signOut: vi.fn(async () => view('a', null, 'signed-out')),
    plans: vi.fn(async () => ({ ok: true as const, data: { subscriptions: [], catalog: [] } })),
    connections: vi.fn(async () => ({ ok: true as const, data: { available: true, toolkits: [], accounts: [] } })),
    connect: vi.fn(async () => ({
      ok: true as const,
      data: { url: 'https://connect.composio.dev/x', expiresAt: new Date(Date.now() + 60000).toISOString(), id: null },
    })),
    disconnect: vi.fn(async () => ({ ok: true as const, data: null })),
    billing: vi.fn(async () => ({ ok: true as const, data: 'u' })),
    open: vi.fn(async () => {}),
    initializeModel: vi.fn(async () => true),
    mcpServers: vi.fn(async () => ({ ok: true as const, data: [server()] })),
    saveMcpServer: vi.fn(async () => ({ ok: true as const, data: server() })),
    deleteMcpServer: vi.fn(async () => ({ ok: true as const, data: null })),
    setMcpEnabled: vi.fn(async () => ({ ok: true as const, data: server() })),
    probeMcpServer: vi.fn(async () => ({ ok: true as const, data: probeData })),
    ...overrides,
  }
  return { api, model: new ProductModel(api, 30000) }
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

let switchCount = 0
/** Switch to a different account while an operation is in flight. */
const switchAccount = (model: ProductModel) => {
  switchCount += 1
  model.adopt(view(`switch-${String(switchCount)}`))
}

describe('every in-flight operation is fenced by the account generation', () => {
  it('start: a superseded attempt never opens the browser', async () => {
    const gate = Promise.withResolvers<AccountView>()
    const { api, model } = fixture({ start: vi.fn(async () => gate.promise) })
    const starting = model.start()
    switchAccount(model)
    gate.resolve(waiting('attempt-1'))
    await starting
    expect(api.open).not.toHaveBeenCalled()
  })

  it('start: a failure from a superseded observation is not reported', async () => {
    const gate = Promise.withResolvers<AccountView>()
    const { model } = fixture({ start: vi.fn(async () => gate.promise) })
    const starting = model.start()
    switchAccount(model)
    gate.reject(new Error('late'))
    await starting
    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })

  it('openLogin: a blocked handoff from a superseded account is not reported', async () => {
    const open = Promise.withResolvers<undefined>()
    const { model } = fixture({
      start: vi.fn(async () => waiting('attempt-1')),
      open: vi.fn(async () => open.promise),
    })
    const starting = model.start()
    await settle()
    switchAccount(model)
    open.reject(new Error('blocked'))
    await starting
    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })

  it('cancel: a failure from a superseded account is not reported', async () => {
    const gate = Promise.withResolvers<AccountView>()
    const { model } = fixture({ cancel: vi.fn(async () => gate.promise) })
    model.adopt(waiting('attempt-1'))
    const cancelling = model.cancel()
    switchAccount(model)
    gate.reject(new Error('late'))
    await cancelling
    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })

  it('signOut: a failure from a superseded account is not reported', async () => {
    const gate = Promise.withResolvers<AccountView>()
    const { model } = fixture({ signOut: vi.fn(async () => gate.promise) })
    const signingOut = model.signOut()
    switchAccount(model)
    gate.reject(new Error('late'))
    expect(await signingOut).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })

  it('initializeModel: later replies from a superseded account are dropped', async () => {
    const ready = Promise.withResolvers<boolean>()
    const { model } = fixture({ initializeModel: vi.fn(async () => ready.promise) })
    const initializing = model.initializeModel()
    switchAccount(model)
    ready.resolve(false)
    await initializing
    expect(model.state.getSnapshot().modelFailed).toBe(false)
  })

  it('initializeModel: a thrown initialization is dropped after an account change', async () => {
    const ready = Promise.withResolvers<boolean>()
    const { model } = fixture({ initializeModel: vi.fn(async () => ready.promise) })
    const initializing = model.initializeModel()
    switchAccount(model)
    ready.reject(new Error('late'))
    await initializing
    expect(model.state.getSnapshot().modelFailed).toBe(false)
  })

  it('initializeModel: a reset leaves the joined initialization untouched', async () => {
    const ready = Promise.withResolvers<boolean>()
    const { model } = fixture({ initializeModel: vi.fn(async () => ready.promise) })
    const initializing = model.initializeModel()
    model.reset()
    ready.resolve(true)
    await initializing
    // A later call is a new initialization rather than the dropped one.
    await model.initializeModel()
    expect(model.state.getSnapshot().initializingModel).toBe(false)
  })

  it('refreshProfile: the older read fails silently while the new account reads again', async () => {
    const stale = Promise.withResolvers<Awaited<ReturnType<ProductApi['profile']>>>()
    let reads = 0
    const { model } = fixture({
      profile: vi.fn(async () => {
        reads += 1
        return reads === 1 ? stale.promise : { id: profileId('fresh'), name: 'Fresh', contact: null }
      }),
    })
    const reading = model.refreshProfile()
    switchAccount(model)
    stale.reject(new Error('late'))
    await reading
    await settle()
    expect(model.state.getSnapshot().accountFailed).toBe(false)
    expect(model.state.getSnapshot().profile?.id).toBe('fresh')
  })

  it('loadPlans: a failure from a superseded account is not reported', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['plans']>>>()
    const { model } = fixture({ plans: vi.fn(async () => gate.promise) })
    const reading = model.loadPlans()
    switchAccount(model)
    gate.reject(new Error('late'))
    await reading
    expect(model.state.getSnapshot().plansFailed).toBe(false)
  })

  it('loadConnections: a thrown read from a superseded account is not reported', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['connections']>>>()
    const { model } = fixture({ connections: vi.fn(async () => gate.promise) })
    const reading = model.loadConnections()
    switchAccount(model)
    gate.reject(new Error('late'))
    await reading
    expect(model.state.getSnapshot().connectionsFailed).toBe(false)
  })

  it('loadMcpServers: a thrown read from a superseded account is not reported', async () => {
    const gate = Promise.withResolvers<McpResult<CustomMcpServerView[]>>()
    const { model } = fixture({ mcpServers: vi.fn(async () => gate.promise) })
    const reading = model.loadMcpServers()
    switchAccount(model)
    gate.reject(new Error('late'))
    await reading
    expect(model.state.getSnapshot().mcpFailed).toBe(false)
  })

  it('MCP writes: a thrown reply from a superseded account is not reported', async () => {
    const save = Promise.withResolvers<McpResult<CustomMcpServerView>>()
    const remove = Promise.withResolvers<McpResult<null>>()
    const toggle = Promise.withResolvers<McpResult<CustomMcpServerView>>()
    const test = Promise.withResolvers<McpResult<McpServerProbe>>()
    const { model } = fixture({
      saveMcpServer: vi.fn(async () => save.promise),
      deleteMcpServer: vi.fn(async () => remove.promise),
      setMcpEnabled: vi.fn(async () => toggle.promise),
      probeMcpServer: vi.fn(async () => test.promise),
    })
    const saving = model.saveMcpServer(mcpInput)
    switchAccount(model)
    save.reject(new Error('late'))
    expect(await saving).toBe(false)

    const removing = model.deleteMcpServer('docs')
    switchAccount(model)
    remove.reject(new Error('late'))
    expect(await removing).toBe(false)

    const toggling = model.setMcpEnabled('docs', true)
    switchAccount(model)
    toggle.reject(new Error('late'))
    expect(await toggling).toBe(false)

    const probing = model.probeMcpServer(mcpInput)
    switchAccount(model)
    test.reject(new Error('late'))
    expect(await probing).toBe(false)

    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })

  it('billing: a failure from a superseded account is not reported', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['billing']>>>()
    const { model } = fixture({ billing: vi.fn(async () => gate.promise) })
    const billing = model.billing(null, false)
    switchAccount(model)
    gate.reject(new Error('late'))
    expect(await billing).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })

  it('billing: a navigation reply from a superseded account keeps the busy slot free', async () => {
    const open = Promise.withResolvers<undefined>()
    const { model } = fixture({ open: vi.fn(async () => open.promise) })
    const billing = model.billing(null, false)
    await settle()
    switchAccount(model)
    open.resolve(undefined)
    expect(await billing).toBe(false)
    expect(model.state.getSnapshot().busy).toBeNull()
  })

  it('connect: an already remembered link is reused without another authorization write', async () => {
    const { api, model } = fixture()
    await model.connect('github', 'Work')
    await model.connect('github', 'Work')
    expect(api.connect).toHaveBeenCalledOnce()
  })

  it('connect: a superseded reply never opens the browser', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['connect']>>>()
    const { api, model } = fixture({ connect: vi.fn(async () => gate.promise) })
    const connecting = model.connect('github', 'Work')
    switchAccount(model)
    gate.resolve({
      ok: true,
      data: { url: 'https://connect.composio.dev/x', expiresAt: new Date(Date.now() + 60000).toISOString(), id: null },
    })
    expect(await connecting).toBe(false)
    expect(api.open).not.toHaveBeenCalled()
  })

  it('reopenConnection: a superseded open never reports its failure', async () => {
    const reopen = Promise.withResolvers<undefined>()
    let opens = 0
    const { model } = fixture({
      open: vi.fn(async () => {
        opens += 1
        if (opens > 1) await reopen.promise
      }),
      connections: vi.fn(async () => ({
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
    const reopening = model.reopenConnection(connectionId)
    switchAccount(model)
    reopen.reject(new Error('late'))
    await reopening
    expect(model.state.getSnapshot().navigationFailed).toBe(false)
  })

  it('reopenConnection: a superseded open never starts a handoff', async () => {
    const reopen = Promise.withResolvers<undefined>()
    let opens = 0
    const { model } = fixture({
      open: vi.fn(async () => {
        opens += 1
        if (opens > 1) await reopen.promise
      }),
      connections: vi.fn(async () => ({
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
    const reopening = model.reopenConnection(connectionId)
    switchAccount(model)
    reopen.resolve(undefined)
    await reopening
    expect(model.state.getSnapshot().handoff).toBeNull()
  })

  it('disconnect: a forgotten account also drops its stored authorization', async () => {
    const { model } = fixture({
      connect: vi.fn(async () => ({
        ok: true as const,
        data: {
          url: 'https://connect.composio.dev/x',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          id: null,
        },
      })),
      connections: vi.fn(async () => ({ ok: true as const, data: { available: true, toolkits: [], accounts: [] } })),
    })
    await model.connect('github', 'Work')
    await model.disconnect(connectionId)
    // The account is gone from the confirmed list, so the link is forgotten too.
    await model.reopenConnection(connectionId)
    expect(model.state.getSnapshot().actionFailed).toBe('global')
  })
})

describe('attempt phase and catalog bookkeeping', () => {
  it('treats an unknown attempt phase as the earliest, so a known later phase wins', () => {
    const { model } = fixture()
    const unknown = 'not-a-phase' as unknown as 'initializing'
    model.adopt({
      ...view('a'),
      attempt: { id: attemptId('attempt-1'), phase: 'succeeded' },
    })
    model.adopt({
      ...view('a'),
      attempt: { id: attemptId('attempt-1'), phase: unknown },
    })
    expect(model.state.getSnapshot().view?.attempt?.phase).toBe('succeeded')
  })

  it('does not re-verify the same failed account observation', async () => {
    const { api, model } = fixture({ profile: vi.fn(async () => null) })
    model.adopt(view('a'))
    await settle()
    expect(api.profile).toHaveBeenCalledOnce()
    expect(model.state.getSnapshot().accountFailed).toBe(true)
    // The same identity arriving again must not start another verification.
    model.adopt(view('a'))
    await settle()
    expect(api.profile).toHaveBeenCalledOnce()
  })

  it('clears the billing handoff when the plan projection changed', async () => {
    let phase = 0
    const owned = (status: string): Plans => ({
      subscriptions: [{
        id: 'sub', planId, name: 'Pro', status, renewsAt: null, cancelAtEnd: false,
        canUpgrade: true, billing: { amountMinor: 100, currency: 'BRL', interval: 'month' },
      }],
      catalog: [],
    })
    const { model } = fixture({
      plans: vi.fn(async () => {
        phase += 1
        return { ok: true as const, data: owned(phase === 1 ? 'active' : 'trialing') }
      }),
    })
    await model.loadPlans()
    await model.billing(planId, true)
    expect(model.state.getSnapshot().handoff).toBe('billing')
    await model.loadPlans()
    expect(model.state.getSnapshot().handoff).toBeNull()
  })
})

describe('remaining connect and disconnect branches', () => {
  it('does not reconcile a connect that settled after the account changed', async () => {
    const open = Promise.withResolvers<undefined>()
    const { api, model } = fixture({ open: vi.fn(async () => open.promise) })
    const connecting = model.connect('github', 'Work')
    await settle()
    switchAccount(model)
    const readsBefore = vi.mocked(api.connections).mock.calls.length
    open.resolve(undefined)
    // The authorization was created, but the new account owns the confirmed list.
    expect(await connecting).toBe(true)
    expect(vi.mocked(api.connections).mock.calls.length).toBe(readsBefore)
    expect(model.state.getSnapshot().busy).toBeNull()
  })

  it('reports a blocked browser from a connect that already created the link', async () => {
    const { model } = fixture({ open: vi.fn(async () => { throw new Error('blocked') }) })
    // The authorization is created and the handoff starts even when navigation fails.
    expect(await model.connect('github', 'Work')).toBe(true)
    expect(model.state.getSnapshot().navigationFailed).toBe(true)
  })

  it('reports a superseded connect failure without touching the new account', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['connect']>>>()
    const { model } = fixture({ connect: vi.fn(async () => gate.promise) })
    const connecting = model.connect('github', 'Work')
    switchAccount(model)
    gate.reject(new Error('late'))
    expect(await connecting).toBe(false)
    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })

  it('refuses a connect click while another command owns the busy slot', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['disconnect']>>>()
    const { api, model } = fixture({ disconnect: vi.fn(async () => gate.promise) })
    const busy = model.disconnect(connectionId)
    expect(await model.connect('github', 'Work')).toBe(false)
    expect(api.connect).not.toHaveBeenCalled()
    gate.resolve({ ok: true, data: null })
    await busy
  })

  it('forgets an authorization whose account left the confirmed list', async () => {
    const { model } = fixture({
      connect: vi.fn(async () => ({
        ok: true as const,
        data: {
          url: 'https://connect.composio.dev/x',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          id: null,
        },
      })),
      connections: vi.fn(async () => ({
        ok: true as const,
        data: { available: true, toolkits: [], accounts: [] },
      })),
    })
    await model.connect('github', 'Work')
    expect(await model.disconnect(connectionId)).toBe(true)
    expect(model.state.getSnapshot().feedback).toBe('disconnectSuccess')
  })

  it('reads an attempt phase absent from the table as the earliest', () => {
    const unknownPhase = 'ghost-phase' as unknown as 'initializing'
    const { model } = fixture()
    model.adopt({ ...view('a'), attempt: { id: attemptId('attempt-9'), phase: unknownPhase } })
    model.adopt({ ...view('a'), attempt: { id: attemptId('attempt-9'), phase: 'succeeded' } })
    expect(model.state.getSnapshot().view?.attempt?.phase).toBe('succeeded')
  })
})

describe('authorization bookkeeping on disconnect', () => {
  it('keeps the link of an account that is still confirmed', async () => {
    const other = 'ca_other' as ConnectionId
    const { model } = fixture({
      connect: vi.fn(async () => ({
        ok: true as const,
        data: {
          url: 'https://connect.composio.dev/x',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          id: null,
        },
      })),
      connections: vi.fn(async () => ({
        ok: true as const,
        data: {
          available: true,
          toolkits: [{ slug: 'github', name: 'GitHub', available: true }],
          accounts: [
            { id: connectionId, toolkit: 'github', label: 'Work', status: 'connected' as const },
            { id: other, toolkit: 'github', label: 'Personal', status: 'connected' as const },
          ],
        },
      })),
    })
    // Two remembered authorizations: only the disconnected account's link goes.
    await model.connect('github', 'Work')
    await model.connect('github', 'Personal')
    await model.loadConnections()
    expect(await model.disconnect(other)).toBe(true)
    // The surviving account still reopens without another authorization write.
    await model.reopenConnection(connectionId)
    expect(model.state.getSnapshot().actionFailed).toBeNull()
  })
})

describe('the last superseded arms', () => {
  it('drops a disconnect result that belongs to an older account', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<ProductApi['disconnect']>>>()
    const { model } = fixture({ disconnect: vi.fn(async () => gate.promise) })
    const disconnecting = model.disconnect(connectionId)
    switchAccount(model)
    gate.resolve({ ok: true, data: null })
    expect(await disconnecting).toBe(false)
    expect(model.state.getSnapshot().feedback).toBeNull()
  })

  it('stays silent when a superseded connect cannot open the browser', async () => {
    const open = Promise.withResolvers<undefined>()
    const { model } = fixture({ open: vi.fn(async () => open.promise) })
    const connecting = model.connect('github', 'Work')
    await settle()
    switchAccount(model)
    open.reject(new Error('blocked'))
    expect(await connecting).toBe(true)
    // Neither the navigation failure nor the busy reset belongs to the new account.
    expect(model.state.getSnapshot().navigationFailed).toBe(false)
    expect(model.state.getSnapshot().busy).toBeNull()
  })
})

describe('an account change during the post-connect reconciliation', () => {
  it('leaves the busy slot to the new account when it changes mid-reconcile', async () => {
    const holder: { model?: ProductModel } = {}
    let switched = false
    const built = fixture({
      connections: vi.fn(async () => {
        // The account changes while the confirmation read is in flight.
        if (!switched && holder.model !== undefined) {
          switched = true
          holder.model.adopt(view('during-reconcile'))
        }
        return { ok: true as const, data: { available: true, toolkits: [], accounts: [] } }
      }),
    })
    holder.model = built.model
    expect(await built.model.connect('github', 'Work')).toBe(true)
    expect(switched).toBe(true)
    // The reset belongs to the superseded account, so the new one keeps its own state.
    expect(built.model.state.getSnapshot().busy).toBeNull()
  })
})
