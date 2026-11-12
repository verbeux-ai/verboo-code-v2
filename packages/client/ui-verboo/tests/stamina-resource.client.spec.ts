// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { AccountCredentialRevision, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { StaminaStatus, PlanId } from '@deepseek-ai/dsh-api-verboo-product/types'
import { createStaminaResource, staminaAddress } from '../src/client/stamina-resource.ts'

const reading: StaminaStatus = {
  groupId: '00000000-0000-4000-8000-000000000001' as PlanId, groupName: 'Unlimited',
  remainingPercent: 50, nextOutputTps: 67, recovering: false,
  fullAt: null, accountingPending: false, asOf: '2026-11-04T15:00:00Z',
}
function owner(id: string): Parameters<typeof staminaAddress>[0] {
  return {
    view: { status: 'credential-stored', credentialRevision: id as AccountCredentialRevision, attempt: null, links: { usageUrl: '', topUpUrl: '' } },
    profile: { id: id as AccountUserId, name: id, contact: null },
  }
}
let visible = 'visible'
let online = true
const releases: Array<() => void> = []
beforeEach(() => {
  vi.useFakeTimers()
  visible = 'visible'
  online = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible as DocumentVisibilityState)
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
})
afterEach(async () => {
  while (releases.length) releases.pop()!()
  await vi.advanceTimersByTimeAsync(0)
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function fixture() {
  const account = createSnapshotStore(owner('account-a'))
  const read = vi.fn<ClientRemote['verboo']['getStamina']>().mockResolvedValue({ ok: true, value: { ok: true, data: [reading] } })
  const stamina = createStaminaResource(read, account, 2000)
  const registry = new ResourceRegistry(new Context())
  releases.push(registry.register(stamina.provider))
  const source = registry.source(staminaAddress(account.getSnapshot()))
  return { account, read, stamina, registry, source, hold: () => { releases.push(source.subscribe(() => {})) } }
}

describe('account-scoped stamina resource', () => {
  it('publishes a changed account reading to both chat subscribers', async () => {
    const f = fixture()
    const otherChat = f.registry.source(staminaAddress(f.account.getSnapshot()))
    f.hold()
    releases.push(otherChat.subscribe(() => {}))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.read).toHaveBeenCalledOnce()
    const decreased = { ...reading, remainingPercent: 35 }
    f.read.mockResolvedValueOnce({ ok: true, value: { ok: true, data: [decreased] } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.source.getSnapshot()).toMatchObject({ status: 'live', value: [decreased] })
    expect(otherChat.getSnapshot()).toMatchObject({ status: 'live', value: [decreased] })
  })
  it('shares one in-flight read between the composer and My plan', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<ClientRemote['verboo']['getStamina']>>>()
    f.read.mockReturnValueOnce(pending.promise)
    f.hold()
    f.hold()
    f.stamina.refresh()
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.read).toHaveBeenCalledOnce()
    pending.resolve({ ok: true, value: { ok: true, data: [reading] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.source.getSnapshot()).toMatchObject({ status: 'live', value: [reading] })
  })
  it('retains the last valid reading during failure and clears the notice after recovery', async () => {
    const f = fixture()
    f.hold()
    await vi.advanceTimersByTimeAsync(0)
    f.read.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unavailable' } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.source.getSnapshot()).toMatchObject({ status: 'failed', value: [reading] })
    f.stamina.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.source.getSnapshot()).toMatchObject({ status: 'live', value: [reading], failure: undefined })
  })
  it('hides a disabled selection instead of treating it as full stamina', async () => {
    const f = fixture()
    f.read.mockResolvedValue({ ok: true, value: { ok: true, data: [] } })
    f.hold()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.source.getSnapshot()).toMatchObject({ status: 'live', value: [] })
  })
  it('stops reads while hidden or offline and resumes when visible and online', async () => {
    const f = fixture()
    visible = 'hidden'
    f.hold()
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.read).not.toHaveBeenCalled()
    visible = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.read).toHaveBeenCalledOnce()
    online = false
    window.dispatchEvent(new Event('offline'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.read).toHaveBeenCalledOnce()
    expect(f.source.getSnapshot()).toMatchObject({ status: 'failed', value: [reading], failure: { details: { reason: 'offline' } } })
    online = true
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.source.getSnapshot().status).toBe('live')
  })
  it('aborts and discards an earlier account response before opening the next account', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<ClientRemote['verboo']['getStamina']>>>()
    f.read.mockReturnValueOnce(pending.promise)
    f.hold()
    await vi.advanceTimersByTimeAsync(0)
    const oldSignal = f.read.mock.calls[0]![0]
    f.account.set(owner('account-b'))
    expect(oldSignal!.aborted).toBe(true)
    const next = f.registry.source(staminaAddress(f.account.getSnapshot()))
    expect(next.getSnapshot().value).toBeUndefined()
    pending.resolve({ ok: true, value: { ok: true, data: [reading] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.source.getSnapshot().value).toBeUndefined()
    releases.push(next.subscribe(() => {}))
    await vi.advanceTimersByTimeAsync(0)
    expect(next.getSnapshot()).toMatchObject({ status: 'live', value: [reading] })
  })
  it('cancels pending reads and releases timers on plugin unload', async () => {
    const f = fixture()
    const entered = Promise.withResolvers<undefined>()
    f.read.mockImplementationOnce(signal => new Promise((resolve) => {
      signal!.addEventListener('abort', () => { resolve({ ok: true, value: { ok: false, code: 'account_changed' } }) }, { once: true })
      entered.resolve(undefined)
    }))
    f.hold()
    await entered.promise
    while (releases.length) releases.pop()!()
    expect(f.read.mock.calls[0]![0]!.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(10000)
    f.stamina.refresh()
    window.dispatchEvent(new Event('online'))
    expect(f.read).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.source.getSnapshot().status).toBe('none')
  })
  it('never creates a resource address before account identity is known', () => {
    expect(staminaAddress({ view: null, profile: null })).toBe('')
    expect(staminaAddress({ ...owner('a'), profile: null })).toBe('')
    expect(staminaAddress({ ...owner('a'), view: { ...owner('a').view!, status: 'signed-out' } })).toBe('')
  })
})
