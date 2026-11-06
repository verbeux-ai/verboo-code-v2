// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { PlanId, StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import { StaminaIndicatorReading, StaminaLiquid } from '../src/client/StaminaLiquid.tsx'

afterEach(cleanup)
const reading: StaminaStatus = {
  groupId: '00000000-0000-4000-8000-000000000001' as PlanId, groupName: 'Unlimited',
  remainingPercent: 50, nextOutputTps: 67, recovering: false,
  fullAt: null, accountingPending: false, asOf: '2026-11-04T15:00:00Z',
}

const labels = { label: 'Stamina', staleLabel: 'Showing the last confirmed reading.' }

describe('liquid stamina beside the model selector', () => {
  it.each([0, 50, 100])('paints the confirmed level without a numeric readout: %s', (remainingPercent) => {
    const { container } = render(<StaminaLiquid remainingPercent={remainingPercent} stale={false} />)
    const water = container.querySelector<HTMLElement>('[data-stamina-water]')!
    expect(water.style.width).toBe(`${remainingPercent}%`)
    expect(water.hasAttribute('data-waves')).toBe(remainingPercent > 0 && remainingPercent < 100)
    expect(container.textContent).toBe('')
    expect(container.querySelector('[aria-valuenow]')).toBeNull()
  })
  it.each([undefined, []])('paints no invented reading for unknown or absent enrollment: %s', (rows) => {
    const { container } = render(<StaminaIndicatorReading rows={rows} stale={false} {...labels} />)
    expect(container.firstChild).toBeNull()
  })
  it('uses the least-full confirmed enrolled plan without changing its value', () => {
    const other = { ...reading, groupId: '00000000-0000-4000-8000-000000000002' as PlanId, remainingPercent: 25 }
    const { container, getByRole } = render(<StaminaIndicatorReading rows={[reading, other]} stale={false} {...labels} />)
    expect(container.querySelector<HTMLElement>('[data-stamina-water]')!.style.width).toBe('25%')
    const meter = getByRole('meter', { name: 'Stamina' })
    expect(meter.getAttribute('aria-valuenow')).toBe('25')
    expect(meter.getAttribute('tabindex')).toBe('0')
    expect(meter.textContent).toBe('')
  })
  it('retains the last confirmed level with a stale presentation after a refresh failure', () => {
    const { container } = render(<StaminaIndicatorReading rows={[reading]} stale {...labels} />)
    expect(container.querySelector('[data-verboo-stamina-liquid]')!.hasAttribute('data-stale')).toBe(true)
    expect(container.querySelector<HTMLElement>('[data-stamina-water]')!.style.width).toBe('50%')
  })
})
