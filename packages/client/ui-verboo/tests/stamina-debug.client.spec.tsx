// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PlanId, StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import { StaminaDebugReading } from '../src/client/StaminaDebug.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const labels: Readonly<Record<string, string>> = en
const row: StaminaStatus = {
  groupId: '00000000-0000-4000-8000-000000000001' as PlanId, groupName: 'Pro',
  remainingPercent: 99.9987654321, nextOutputTps: 173, recovering: false,
  fullAt: null, accountingPending: false, asOf: '2026-11-07T18:00:00Z',
}
function fixture(): ComponentProps<typeof StaminaDebugReading> {
  return {
    rows: [row], failed: false, locale: 'en', refresh: vi.fn(),
    t: (key, values) => {
      const template = labels[key]
      if (template === undefined) throw new Error(`Missing test translation: ${key}`)
      return template.replace(/\{(\w+)\}/g, (_match: string, name: string) => String(values?.[name] ?? ''))
    },
  }
}
describe('opt-in stamina diagnostics', () => {
  it('shows exact server percentages and server timestamps, without generation rates', () => {
    const props = fixture()
    const view = render(<StaminaDebugReading {...props} />)
    expect(view.container.textContent).toContain('Pro: 99.9987654321%')
    expect(view.container.querySelector('time')!.dateTime).toBe(row.asOf)
    expect(view.container.textContent).not.toMatch(/173|TPS|tok\/s|tokens\/s/)
    expect(view.getByRole('status').getAttribute('aria-live')).toBe('off')
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }))
    expect(props.refresh).toHaveBeenCalledOnce()
    view.rerender(<StaminaDebugReading {...props} rows={[{ ...row, remainingPercent: 99.987654321 }]} />)
    expect(view.container.textContent).toContain('99.987654321%')
    expect(view.container.textContent).not.toContain('99.9987654321%')
  })
  it('retains the confirmed value during failures and exposes pending accounting', () => {
    const view = render(<StaminaDebugReading {...fixture()} rows={[{ ...row, accountingPending: true }]} failed />)
    expect(view.container.textContent).toContain('99.9987654321%')
    expect(view.container.textContent).toContain(en.staminaStale)
    expect(view.container.textContent).toContain(en.staminaDebugPending)
  })
  it('never invents a full reading when data is unknown or no enrollment is returned', () => {
    const props = fixture()
    const view = render(<StaminaDebugReading {...props} rows={undefined} />)
    expect(view.container.textContent).toContain(en.staminaDebugEmpty)
    expect(view.container.textContent).not.toContain('%')
    view.rerender(<StaminaDebugReading {...props} rows={[]} />)
    expect(view.container.textContent).not.toContain('%')
    view.rerender(<StaminaDebugReading {...props} rows={undefined} failed />)
    expect(view.container.textContent).toContain(en.staminaDebugFailed)
  })
})
