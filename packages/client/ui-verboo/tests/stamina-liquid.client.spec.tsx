// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PlanId, StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import { StaminaButtonReading, StaminaLiquid } from '../src/client/StaminaLiquid.tsx'
import { pt } from '../src/client/locales.ts'

afterEach(cleanup)
const reading: StaminaStatus = {
  groupId: '00000000-0000-4000-8000-000000000001' as PlanId, groupName: 'Unlimited',
  remainingPercent: 50, nextOutputTps: 67, recovering: false,
  fullAt: null, accountingPending: false, asOf: '2026-11-04T15:00:00Z',
}
function readingProps() {
  const props = {
    locale: 'pt-BR',
    onDescriptionChange: vi.fn<(description: string | undefined) => void>(),
    t: (key, values) => pt[key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? '')),
  } satisfies Omit<ComponentProps<typeof StaminaButtonReading>, 'reading' | 'stale'>
  return props
}


describe('liquid stamina inside the primary action', () => {
  it.each([0, 50, 99.9, 99.99, 100])('paints the confirmed level without a numeric readout: %s', (remainingPercent) => {
    const { container } = render(<StaminaLiquid remainingPercent={remainingPercent} stale={false} />)
    const water = container.querySelector<HTMLElement>('[data-stamina-water]')!
    expect(water.style.height).toBe(`${remainingPercent}%`)
    expect(water.hasAttribute('data-surface')).toBe(remainingPercent > 0 && remainingPercent < 100)
    expect(container.querySelector('[data-stamina-ring]')).not.toBeNull()
    expect(container.textContent).toBe('')
    expect(container.querySelector('[aria-valuenow]')).toBeNull()
  })
  it('paints no invented reading when the selected group has no enrollment', () => {
    const props = readingProps()
    const { container } = render(<StaminaButtonReading {...props} reading={undefined} stale={false} />)
    expect(container.firstChild).toBeNull()
    expect(props.onDescriptionChange).not.toHaveBeenCalled()
  })
  it('paints the selected group’s confirmed value without changing it', () => {
    const { container } = render(<StaminaButtonReading {...readingProps()} reading={reading} stale={false} />)
    expect(container.querySelector<HTMLElement>('[data-stamina-water]')!.style.height).toBe('50%')
  })
  it('retains the last confirmed level with a stale presentation after a refresh failure', () => {
    const props = readingProps()
    const { container } = render(<StaminaButtonReading {...props} reading={reading} stale />)
    expect(container.querySelector('[data-verboo-stamina-liquid]')!.hasAttribute('data-stale')).toBe(true)
    expect(container.querySelector<HTMLElement>('[data-stamina-water]')!.style.height).toBe('50%')
    expect(props.onDescriptionChange).toHaveBeenLastCalledWith(expect.stringContaining('última leitura confirmada'))
  })
  it('describes fractional Max changes, without treating pending usage or recovery as a confirmed drop', () => {
    const props = readingProps()
    const max = { ...reading, groupName: 'Max', remainingPercent: 100 }
    const { rerender } = render(<StaminaButtonReading {...props} reading={max} stale={false} />)
    expect(props.onDescriptionChange).toHaveBeenLastCalledWith('Stamina (Max) · 100% restante')
    const next = { ...max, remainingPercent: 99.99997 }
    rerender(<StaminaButtonReading {...props} reading={{ ...next, accountingPending: true }} stale={false} />)
    expect(props.onDescriptionChange).toHaveBeenLastCalledWith('Stamina (Max) · 99,99997% restante · O uso está sendo confirmado. O limite pode mudar.')
    rerender(<StaminaButtonReading {...props} reading={next} stale={false} />)
    expect(props.onDescriptionChange).toHaveBeenLastCalledWith('Stamina (Max) · 99,99997% restante · Última queda: 0,00003 p.p.')
    rerender(<StaminaButtonReading {...props} reading={next} stale />)
    expect(props.onDescriptionChange).toHaveBeenLastCalledWith(expect.stringContaining('última leitura confirmada'))
    rerender(<StaminaButtonReading {...props} reading={max} stale={false} />)
    expect(props.onDescriptionChange).toHaveBeenLastCalledWith('Stamina (Max) · 100% restante')
    rerender(<StaminaButtonReading {...props} reading={undefined} stale={false} />)
    expect(props.onDescriptionChange).toHaveBeenLastCalledWith(undefined)
  })
})
