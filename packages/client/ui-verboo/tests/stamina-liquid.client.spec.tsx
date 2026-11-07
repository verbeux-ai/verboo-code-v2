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
  it.each([undefined, []])('paints no invented reading for unknown or absent enrollment: %s', (rows) => {
    const { container } = render(<StaminaButtonReading rows={rows} stale={false} />)
    expect(container.firstChild).toBeNull()
  })
  it('uses the least-full confirmed enrolled plan without changing its value', () => {
    const other = { ...reading, groupId: '00000000-0000-4000-8000-000000000002' as PlanId, remainingPercent: 25 }
    const { container } = render(<StaminaButtonReading rows={[reading, other]} stale={false} />)
    expect(container.querySelector<HTMLElement>('[data-stamina-water]')!.style.height).toBe('25%')

  })
  it('retains the last confirmed level with a stale presentation after a refresh failure', () => {
    const { container } = render(<StaminaButtonReading rows={[reading]} stale />)
    expect(container.querySelector('[data-verboo-stamina-liquid]')!.hasAttribute('data-stale')).toBe(true)
    expect(container.querySelector<HTMLElement>('[data-stamina-water]')!.style.height).toBe('50%')
  })
})
