// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { PlanId, StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import { StaminaButtonReading, StaminaLiquid } from '../src/client/StaminaLiquid.tsx'

afterEach(cleanup)
const reading: StaminaStatus = {
  groupId: '00000000-0000-4000-8000-000000000001' as PlanId, groupName: 'Unlimited',
  remainingPercent: 50, nextOutputTps: 67, recovering: false,
  fullAt: null, accountingPending: false, asOf: '2026-11-04T15:00:00Z',
}


describe('liquid stamina inside the primary action', () => {
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
