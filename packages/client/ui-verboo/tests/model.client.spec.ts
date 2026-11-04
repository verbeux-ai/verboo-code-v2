import { describe, expect, it, vi } from 'vitest'
import type {
  AccountView,
  AccountCredentialRevision,
  AccountUserId,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type {
  Connections,
  ConnectionId,
  Plans,
  PlanId,
} from '@deepseek-ai/dsh-api-verboo-product/types'
import { ProductModel } from '../src/client/model.ts'
import type { ProductApi } from '../src/client/model.ts'

const connectionId = 'ca_work' as ConnectionId
const planId = '00000000-0000-4000-8000-000000000001' as PlanId
const view = (revision: string): AccountView => ({
  status: 'credential-stored',
  credentialRevision: revision as AccountCredentialRevision,
  attempt: null,
  links: {
    usageUrl: 'https://code.verboo.ai/pt/dashboard',
    topUpUrl: 'https://code.verboo.ai/pt/plans',
  },
})
const signedOut: AccountView = {
  status: 'signed-out',
  attempt: null,
  links: view('a').links,
}
const emptyPlans: Plans = { subscriptions: [], catalog: [] }
const emptyConnections: Connections = {
  available: true,
  toolkits: [{ slug: 'github', name: 'GitHub', available: true }],
  accounts: [],
}
function fixture() {
  const api: ProductApi = {
    profile: vi.fn(async () => ({
      id: '00000000-0000-4000-8000-000000000002' as AccountUserId,
      name: 'Example',
      contact: null,
    })),
    start: vi.fn(async () => signedOut),
    cancel: vi.fn(async () => signedOut),
    signOut: vi.fn(async () => signedOut),
    plans: vi.fn(async () => ({ ok: true as const, data: emptyPlans })),
    connections: vi.fn(async () => ({
      ok: true as const,
      data: emptyConnections,
    })),
    connect: vi.fn(async () => ({
      ok: true as const,
      data: {
        id: connectionId,
        url: 'https://connect.composio.dev/link/example',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      },
    })),
    disconnect: vi.fn(async () => ({ ok: true as const, data: null })),
    billing: vi.fn(async () => ({
      ok: true as const,
      data: 'https://code.verboo.ai/pt/plans',
    })),
    open: vi.fn(async () => {}),
    initializeModel: vi.fn(async () => true),
  }
  return { api, model: new ProductModel(api, 30000) }
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('account-bound product presenter', () => {
  it('does not repeat account and catalog reads for an unchanged account observation', async () => {
    const { api, model } = fixture()
    model.adopt(view('a'))
    await model.refreshProfile()
    await settle()
    expect(api.profile).toHaveBeenCalledOnce()
    expect(api.plans).toHaveBeenCalledOnce()
    expect(api.connections).toHaveBeenCalledOnce()
    model.adopt(view('a'))
    await settle()
    expect(api.profile).toHaveBeenCalledOnce()
    expect(api.plans).toHaveBeenCalledOnce()
    expect(api.connections).toHaveBeenCalledOnce()
    model.adopt(view('b'))
    await model.refreshProfile()
    expect(api.profile).toHaveBeenCalledTimes(2)
  })

  it('discards a previous account’s late plan and connection responses', async () => {
    const { api, model } = fixture()
    const plans =
      Promise.withResolvers<Awaited<ReturnType<ProductApi['plans']>>>()
    const connections =
      Promise.withResolvers<Awaited<ReturnType<ProductApi['connections']>>>()
    api.plans = vi.fn(() => plans.promise)
    api.connections = vi.fn(() => connections.promise)
    model.adopt(view('a'))
    await model.refreshProfile()
    model.reportActionFailure()
    model.adopt(signedOut)
    plans.resolve({
      ok: true as const,
      data: {
        ...emptyPlans,
        catalog: [
          {
            id: planId,
            name: 'Old private plan',
            description: '',
            priceCents: 100,
            currency: 'USD',
            interval: 'month',
          },
        ],
      },
    })
    connections.resolve({
      ok: true as const,
      data: {
        ...emptyConnections,
        accounts: [
          {
            id: connectionId,
            label: 'Private account',
            toolkit: 'github',
            status: 'connected',
          },
        ],
      },
    })
    await settle()
    expect(model.state.getSnapshot()).toMatchObject({
      profile: null,
      plans: null,
      connections: null,
      actionFailed: null,
    })
  })
  it('allows one read in flight and retains the last valid data on failure', async () => {
    const { api, model } = fixture()
    await model.loadPlans()
    const pending =
      Promise.withResolvers<Awaited<ReturnType<ProductApi['plans']>>>()
    api.plans = vi.fn(() => pending.promise)
    const first = model.loadPlans()
    expect(model.loadPlans()).toBe(first)
    expect(api.plans).toHaveBeenCalledOnce()
    pending.resolve({ ok: false, code: 'request_failed' })
    await first
    expect(model.state.getSnapshot()).toMatchObject({
      plans: emptyPlans,
      plansFailed: true,
      loadingPlans: false,
    })
  })
  it('does not overwrite a newly signed-in account with a late sign-out reply', async () => {
    const { api, model } = fixture()
    model.adopt(view('a'))
    await model.refreshProfile()
    const pending = Promise.withResolvers<AccountView>()
    api.signOut = () => pending.promise
    const signout = model.signOut()
    model.adopt(view('b'))
    pending.resolve(signedOut)
    await signout
    expect(model.state.getSnapshot().view?.credentialRevision).toBe('b')
  })
  it('keeps a failed disconnect visible and returns an actionable failure', async () => {
    const { api, model } = fixture()
    const data: Connections = {
      ...emptyConnections,
      accounts: [
        {
          id: connectionId,
          label: 'Work',
          toolkit: 'github',
          status: 'connected',
        },
      ],
    }
    api.connections = async () => ({ ok: true as const, data })
    await model.loadConnections()
    api.disconnect = async () => ({ ok: false, code: 'request_failed' })
    expect(await model.disconnect(connectionId)).toBe(false)
    expect(model.state.getSnapshot().connections?.accounts).toHaveLength(1)
    expect(model.state.getSnapshot().feedback).toBeNull()
    api.disconnect = async () => ({ ok: true as const, data: null })
    api.connections = async () => ({
      ok: true as const,
      data: emptyConnections,
    })
    expect(await model.disconnect(connectionId)).toBe(true)
    expect(model.state.getSnapshot().connections?.accounts).toHaveLength(0)
    expect(model.state.getSnapshot().feedback).toBe('disconnectSuccess')
    api.connections = async () => ({ ok: true as const, data })
    await model.loadConnections()
    api.disconnect = async () => ({ ok: false, code: 'request_failed' })
    expect(await model.disconnect(connectionId)).toBe(false)
    expect(model.state.getSnapshot()).toMatchObject({
      feedback: null,
      actionFailed: 'disconnect',
    })
  })
  it('reconciles a created authorization even when opening the browser fails, and reopens without another POST', async () => {
    const { api, model } = fixture()
    api.open = vi.fn(async () => {
      throw new Error('browser closed')
    })
    api.connections = async () => ({
      ok: true as const,
      data: {
        ...emptyConnections,
        accounts: [
          {
            id: connectionId,
            label: 'Work',
            toolkit: 'github',
            status: 'pending',
          },
        ],
      },
    })
    expect(await model.connect('github', 'Work')).toBe(true)
    expect(model.state.getSnapshot()).toMatchObject({
      navigationFailed: true,
      handoff: 'connection',
      authorizationIds: [connectionId],
    })
    api.open = vi.fn(async () => {})
    await model.reopenConnection(connectionId)
    expect(api.connect).toHaveBeenCalledOnce()
    expect(api.open).toHaveBeenCalledOnce()
  })
  it('ends polling after its deadline and only confirms the exact authorization target', async () => {
    const { api, model } = fixture()
    await model.connect('github', 'Work')
    expect(model.shouldPoll(Date.now())).toBe(true)
    api.connections = async () => ({
      ok: true as const,
      data: {
        ...emptyConnections,
        accounts: [
          {
            id: 'ca_other' as ConnectionId,
            label: 'Personal',
            toolkit: 'github',
            status: 'connected',
          },
        ],
      },
    })
    await model.loadConnections()
    expect(model.state.getSnapshot().handoff).toBe('connection')
    api.connections = async () => ({
      ok: true as const,
      data: {
        ...emptyConnections,
        accounts: [
          {
            id: connectionId,
            label: 'Work',
            toolkit: 'github',
            status: 'connected',
          },
        ],
      },
    })
    await model.loadConnections()
    expect(model.state.getSnapshot().handoff).toBeNull()
    expect(model.state.getSnapshot().feedback).toBe('connectionSuccess')
    await model.billing(planId, true)
    expect(model.shouldPoll(Date.now() + 30001)).toBe(false)
  })
  it('does not infer a purchase from browser navigation or another plan’s update', async () => {
    const { api, model } = fixture()
    await model.loadPlans()
    await model.billing(planId, true)
    expect(model.state.getSnapshot().plans?.subscriptions).toEqual([])
    api.plans = async () => ({
      ok: true as const,
      data: {
        ...emptyPlans,
        subscriptions: [
          {
            id: 'other',
            planId: '00000000-0000-4000-8000-000000000003' as PlanId,
            name: 'Other',
            status: 'active',
            renewsAt: null,
            cancelAtEnd: false,
            canUpgrade: true,
            billing: null,
          },
        ],
      },
    })
    await model.loadPlans()
    expect(model.state.getSnapshot().handoff).toBe('billing')
    await model.billing(null, false)
    expect(model.state.getSnapshot().handoff).toBeNull()
  })
  it('keeps model setup failures separate from account verification and joins retries', async () => {
    const { api, model } = fixture()
    const pending = Promise.withResolvers<boolean>()
    api.initializeModel = vi.fn(() => pending.promise)
    const first = model.initializeModel()
    expect(model.initializeModel()).toBe(first)
    pending.resolve(false)
    await first
    expect(api.initializeModel).toHaveBeenCalledOnce()
    expect(model.state.getSnapshot()).toMatchObject({
      accountFailed: false,
      modelFailed: true,
      initializingModel: false,
    })
  })
})
