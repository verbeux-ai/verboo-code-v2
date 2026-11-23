// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { PlanId, StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { AccountCredentialRevision, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ProductSnapshot } from '../src/client/model.ts'
import type { StaminaModelState } from '../src/client/stamina-selection.ts'
import { StaminaButtonFill, StaminaButtonReading, StaminaLiquid } from '../src/client/StaminaLiquid.tsx'
import { StaminaDock, StaminaPanel } from '../src/client/Stamina.tsx'

afterEach(cleanup)
const reading: StaminaStatus = {
  groupId: '00000000-0000-4000-8000-000000000001' as PlanId, groupName: 'Unlimited',
  remainingPercent: 50, nextOutputTps: 67, recovering: false,
  fullAt: null, accountingPending: false, asOf: '2026-11-04T15:00:00Z',
}


const account: ProductSnapshot = {
  view: { status: 'credential-stored', credentialRevision: 'revision-a' as AccountCredentialRevision,
    attempt: null, links: { usageUrl: '', topUpUrl: '' } },
  profile: { id: 'account-a' as AccountUserId, name: 'Fixture', contact: null },
  profilePreviouslyVerified: true, initialized: true, accountFailed: false, actionFailed: null,
  starting: false, plans: { subscriptions: [], catalog: [{
    id: reading.groupId, slug: 'unlimited', name: reading.groupName, description: '',
    priceCents: 100, currency: 'BRL', interval: 'month',
  }] }, connections: null, plansFailed: false, connectionsFailed: false,
  loadingPlans: false, loadingConnections: false, busy: null, handoff: null, handoffUntil: 0,
  connectedTarget: null, feedback: null, modelFailed: false, initializingModel: false,
  browserBlocked: false, navigationFailed: false, authorizationIds: [], mcpServers: null,
  loadingMcp: false, mcpFailed: false, mcpProbe: null, probingMcp: false, mcpError: null,
}

describe('liquid stamina inside the primary action', () => {
  it('uses the current account resource and hides its reading for an unrelated model', () => {
    let current: StaminaModelState['current'] = { provider: 'deepseek-account', model: 'unlimited/model' }
    const useResource = vi.fn().mockReturnValue({
      status: 'failed', value: [reading],
      failure: new RemoteError('verboo/stamina-unavailable', 'Fixture unavailable', { reason: 'offline' }),
    })
    const props: Parameters<typeof StaminaButtonFill>[0] = {
      useProduct: selector => selector(account),
      useStaminaModel: selector => selector({ current }),
      useResource,
    }
    const { container, rerender } = render(<StaminaButtonFill {...props} />)
    expect(useResource).toHaveBeenCalledWith('dsh-resource://verboo-stamina/revision-a/account-a')
    expect(container.querySelector<HTMLElement>('[data-stamina-water]')?.style.height).toBe('50%')
    expect(container.querySelector('[data-stale]')).not.toBeNull()
    current = { provider: 'other-provider', model: 'unlimited/model' }
    rerender(<StaminaButtonFill {...props} />)
    expect(container.firstChild).toBeNull()
  })
  it.each([0, 50, 100])('paints the confirmed level without a numeric readout: %s', (remainingPercent) => {
    const { container } = render(<StaminaLiquid remainingPercent={remainingPercent} stale={false} />)
    const water = container.querySelector<HTMLElement>('[data-stamina-water]')!
    expect(water.style.height).toBe(`${remainingPercent}%`)
    expect(water.hasAttribute('data-waves')).toBe(remainingPercent > 0 && remainingPercent < 100)
    expect(container.querySelector('[data-stamina-ring]')).not.toBeNull()
    expect(container.textContent).toBe('')
    expect(container.querySelector('[aria-valuenow]')).toBeNull()
  })
  it('paints no invented reading when the selected group has no enrollment', () => {
    const { container } = render(<StaminaButtonReading reading={undefined} stale={false} />)
    expect(container.firstChild).toBeNull()
  })
  it('paints the selected group’s confirmed value without changing it', () => {
    const { container } = render(<StaminaButtonReading reading={reading} stale={false} />)
    expect(container.querySelector<HTMLElement>('[data-stamina-water]')!.style.height).toBe('50%')
  })
  it('retains the last confirmed level with a stale presentation after a refresh failure', () => {
    const { container } = render(<StaminaButtonReading reading={reading} stale />)
    expect(container.querySelector('[data-verboo-stamina-liquid]')!.hasAttribute('data-stale')).toBe(true)
    expect(container.querySelector<HTMLElement>('[data-stamina-water]')!.style.height).toBe('50%')
  })
})

it('shows the same confirmed balance in the plan panel and composer dock', () => {
  const useResource = vi.fn().mockReturnValue({
    status: 'live', value: [{ ...reading, remainingPercent: 100 }], failure: undefined,
  })
  const props: Parameters<typeof StaminaPanel>[0] = {
    useProduct: selector => selector(account),
    usePreferences: selector => selector({ locale: 'en', theme: 'system', languages: [] }),
    useResource,
    t: key => key,
    refreshStamina: vi.fn(),
  }
  const view = render(<StaminaPanel {...props} />)
  expect(screen.getByRole('heading', { name: 'staminaTitle' })).toBeTruthy()
  expect(screen.getByText('staminaFull')).toBeTruthy()
  expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(100)
  view.rerender(<StaminaDock {...props} />)
  expect(screen.queryByRole('heading')).toBeNull()
  expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(100)
  expect(useResource).toHaveBeenNthCalledWith(1, 'dsh-resource://verboo-stamina/revision-a/account-a')
  expect(useResource).toHaveBeenNthCalledWith(2, 'dsh-resource://verboo-stamina/revision-a/account-a')
})
