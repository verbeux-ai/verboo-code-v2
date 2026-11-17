import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AccountCredentialRevision } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ProductSnapshot } from '../src/client/model.ts'
import { TrialModel, type TrialApi } from '../src/client/trial-model.ts'
import type { PlanId, TrialStatus, TrialOffer, Result, TrialId, TrialOfferId, TrialAttemptId } from '@deepseek-ai/dsh-api-verboo-product/types'
const plan = '00000000-0000-4000-8000-000000000001' as PlanId
function fixture() {
  const account = createSnapshotStore({
    view: { status: 'credential-stored', credentialRevision: 'one' },
    profile: { id: 'account-a' },
  } as ProductSnapshot)
  const status: TrialStatus = {
    asOf: new Date().toISOString(),
    trials: [{ id: 'trial' as TrialId, groupId: plan, source: 'free_tokens', state: 'ended', tokensRemaining: 0 }],
  }
  const offer: TrialOffer = {
    id: 'offer' as TrialOfferId,
    paymentMethod: 'card',
    pixAvailable: false,
    planId: plan,
    name: 'Pro',
    amountMinor: 6900,
    renewalAmountMinor: 6900,
    currency: 'USD',
    interval: 'month',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    methods: ['card'],
    card: null,
  }
  const api: TrialApi = {
    status: vi.fn<TrialApi['status']>(async () => ({ ok: true, data: status })),
    offer: vi.fn<TrialApi['offer']>(async () => ({ ok: true, data: offer })),
    confirm: vi.fn<TrialApi['confirm']>(async () => ({
      ok: true,
      data: { status: 'requires_action', attemptId: 'original' as TrialAttemptId, url: 'https://checkout.stripe.com/original' },
    })),
    resume: vi.fn<TrialApi['resume']>(async () => ({
      ok: true,
      data: { status: 'requires_action', attemptId: 'original' as TrialAttemptId, url: 'https://checkout.stripe.com/original' },
    })),
    payment: vi.fn<TrialApi['payment']>(async () => ({ ok: false, code: 'not_found' })),
    open: vi.fn(async () => {}),
    refreshPlans: vi.fn(),
  }
  const saved = new Map<string, string>()
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value)
    },
    removeItem: (key: string) => {
      saved.delete(key)
    },
  }
  const model = new TrialModel(api, account, storage)
  return { model, api, account, status, offer, saved, storage }
}
describe('trial attention lifetime', () => {
  it('opens on real exhaustion, stays dismissed through polling and returns on app launch', async () => {
    const f = fixture()
    await f.model.refresh()
    expect(f.model.state.getSnapshot().open).toBe(true)
    f.model.close()
    await f.model.refresh()
    expect(f.model.state.getSnapshot().open).toBe(false)
    const account = f.account.getSnapshot()
    if (!account.view) throw new Error('Fixture account is required')
    f.account.set({ ...account, view: { ...account.view, credentialRevision: 'rotated' as AccountCredentialRevision } })
    await f.model.refresh()
    expect(f.model.state.getSnapshot().open).toBe(false)
    const reopened = new TrialModel(f.api, f.account, f.storage)
    await reopened.refresh()
    expect(reopened.state.getSnapshot().open).toBe(true)
  })
  it('shows an early upgrade opportunity without an automatic modal', async () => {
    const f = fixture()
    f.status.trials[0]!.state = 'ending'
    await f.model.refresh()
    expect(f.model.state.getSnapshot()).toMatchObject({ open: false, notices: [{ state: 'ending' }] })
  })
  it('retains the last trial reading on failure but prevents charging from stale data', async () => {
    const f = fixture()
    await f.model.refresh()
    await f.model.quote(plan)
    vi.mocked(f.api.status).mockResolvedValueOnce({ ok: false, code: 'unavailable' })
    await f.model.refresh()
    await f.model.confirm('card')
    expect(f.model.state.getSnapshot().notices).toHaveLength(1)
    expect(f.api.confirm).not.toHaveBeenCalled()
  })
  it('fences late replies when the owning account changes', async () => {
    const f = fixture()
    let settle!: (status: Result<TrialStatus>) => void
    vi.mocked(f.api.status).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve
        }),
    )
    const read = f.model.refresh()
    f.account.set({ ...f.account.getSnapshot(), profile: null })
    f.model.adopt()
    settle({ ok: true, data: f.status })
    await read
    expect(f.model.state.getSnapshot().notices).toEqual([])
    expect(f.model.state.getSnapshot().open).toBe(false)
  })
  it('saves the original payment identity before a write and suppresses repeated clicks', async () => {
    const f = fixture()
    await f.model.refresh()
    await f.model.quote(plan)
    vi.mocked(f.api.confirm).mockImplementationOnce(async () => {
      expect(f.saved.size).toBe(1)
      return { ok: true, data: { status: 'pending', attemptId: 'original' as TrialAttemptId, url: null } }
    })
    await Promise.all([f.model.confirm('card'), f.model.confirm('card')])
    expect(f.api.confirm).toHaveBeenCalledTimes(1)
    expect(f.model.state.getSnapshot().payment?.status).toBe('pending')
  })
  it('does not treat browser navigation or collector failures as a successful payment', async () => {
    const f = fixture()
    await f.model.refresh()
    await f.model.quote(plan)
    await f.model.confirm('card')
    expect(f.api.open).toHaveBeenCalled()
    expect(f.api.refreshPlans).not.toHaveBeenCalled()
    expect(f.model.state.getSnapshot().payment?.status).toBe('requires_action')
  })
})

it('requires another explicit confirmation after saving a card', async () => {
  const f = fixture()
  await f.model.refresh()
  await f.model.quote(plan)
  vi.mocked(f.api.confirm).mockResolvedValueOnce({
    ok: true,
    data: { status: 'setup_required', attemptId: null, url: 'https://checkout.stripe.com/setup' },
  })
  await f.model.confirm('card')
  expect(f.api.confirm).toHaveBeenCalledTimes(1)
  vi.mocked(f.api.offer).mockResolvedValueOnce({
    ok: true,
    data: { ...f.offer, card: { brand: 'visa', last4: '4242' } },
  })
  await f.model.refresh()
  expect(f.model.state.getSnapshot().offer?.card?.last4).toBe('4242')
  expect(f.model.state.getSnapshot().payment).toBeNull()
  expect(f.api.confirm).toHaveBeenCalledTimes(1)
})

it('reconciles a response lost after the server started checkout without another write', async () => {
  const f = fixture()
  await f.model.refresh()
  await f.model.quote(plan)
  vi.mocked(f.api.confirm).mockResolvedValueOnce({ ok: false, code: 'request_failed' })
  await f.model.confirm('card')
  const originalRequest = vi.mocked(f.api.confirm).mock.calls[0]![2]
  const reopened = new TrialModel(f.api, f.account, f.storage)
  vi.mocked(f.api.payment).mockResolvedValueOnce({ ok: true, data: { status: 'requires_action' } })
  await reopened.refresh()
  expect(f.api.payment).toHaveBeenCalledWith(originalRequest)
  expect(reopened.state.getSnapshot().payment?.status).toBe('pending')
  expect(f.api.confirm).toHaveBeenCalledTimes(1)
})

it('suppresses the offer for the paid selected group without lending access to another group', async () => {
  const f = fixture()
  const paid = '00000000-0000-4000-8000-000000000009' as PlanId
  f.status.paidGroupIds = [paid]
  await f.model.refresh()
  expect(f.model.state.getSnapshot().open).toBe(false)
  f.model.selectGroup(paid)
  expect(f.model.state.getSnapshot().notices).toEqual([])
  f.model.selectGroup(plan)
  expect(f.model.state.getSnapshot().open).toBe(true)
  expect(f.model.state.getSnapshot().notices[0]?.groupId).toBe(plan)
})

it('persists the server quote attempt before charging a saved card and recovers it after timeout',async()=>{
  const f=fixture();const serverAttempt='00000000-0000-4000-8000-000000000007' as TrialAttemptId
  f.offer.attemptId=serverAttempt;f.offer.card={ brand:'visa',last4:'4242' }
  await f.model.refresh();await f.model.quote(plan)
  vi.mocked(f.api.confirm).mockResolvedValueOnce({ ok:false,code:'request_failed' })
  await f.model.confirm('card')
  const restored=new TrialModel(f.api,f.account,f.storage)
  vi.mocked(f.api.payment).mockResolvedValueOnce({ ok:true,data:{ status:'requires_action' } })
  await restored.refresh()
  expect(f.api.payment).toHaveBeenCalledWith(serverAttempt)
  expect(f.api.confirm).toHaveBeenCalledTimes(1)
})

it('requires a new quote and another explicit confirmation when the server rejects before charging', async () => {
  const f = fixture()
  await f.model.refresh()
  await f.model.quote(plan)
  vi.mocked(f.api.confirm).mockResolvedValueOnce({ ok: false, code: 'quote_changed' })
  await f.model.confirm('card')
  expect(f.model.state.getSnapshot()).toMatchObject({ offer: null, payment: null, error: 'quote' })
  expect(f.saved.size).toBe(0)
  expect(f.api.confirm).toHaveBeenCalledTimes(1)
  await f.model.quote(plan)
  expect(f.api.confirm).toHaveBeenCalledTimes(1)
  await f.model.confirm('card')
  expect(f.api.confirm).toHaveBeenCalledTimes(2)
})

it('does not repeat an unconfirmed financial write even when its original response was lost', async () => {
  const f = fixture()
  await f.model.refresh()
  await f.model.quote(plan)
  vi.mocked(f.api.confirm).mockRejectedValueOnce(new Error('response lost'))
  await f.model.confirm('card')
  await f.model.confirm('card')
  expect(f.api.confirm).toHaveBeenCalledTimes(1)
  expect(f.saved.size).toBe(1)
})

it('closes and retires the paid offer after confirmed payment even while the old group notice remains', async () => {
  const f = fixture()
  await f.model.refresh()
  await f.model.quote(plan)
  vi.mocked(f.api.confirm).mockResolvedValueOnce({ ok: true, data: { status: 'completed', attemptId: 'paid' as TrialAttemptId, url: null } })
  await f.model.confirm('card')
  expect(f.model.state.getSnapshot()).toMatchObject({ open: false, offer: null, payment: { status: 'completed' } })
  await f.model.confirm('card')
  expect(f.api.confirm).toHaveBeenCalledTimes(1)
})
