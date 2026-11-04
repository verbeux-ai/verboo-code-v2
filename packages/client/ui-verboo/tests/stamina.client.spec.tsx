// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PlanId, StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import { StaminaDisplay } from '../src/client/Stamina.tsx'
import { en, pt, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const reading: StaminaStatus = {
  groupId: '00000000-0000-4000-8000-000000000001' as PlanId, groupName: 'Unlimited',
  remainingPercent: 50, nextOutputTps: 67, recovering: false,
  fullAt: null, accountingPending: false, asOf: '2026-11-04T15:00:00Z',
}
function props(locale = 'pt'): ComponentProps<typeof StaminaDisplay> {
  const copy: Readonly<Record<string, string>> = locale === 'pt' ? pt : locale === 'zh' ? zh : en
  return {
    locale, compact: false, rows: [reading], failed: false, refreshStamina: vi.fn(),
    t: (key, values) => (copy[key] ?? key).replace(/\{(\w+)\}/g, (_match: string, name: string) => {
      const value = values?.[name]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    }),
  }
}

describe('public stamina presentation', () => {
  it('shows stamina and the next-request limit without exposing financial reserves', () => {
    render(<StaminaDisplay {...props()} />)
    expect(screen.getByRole('progressbar', { name: 'Stamina: Unlimited' }).getAttribute('value')).toBe('50')
    expect(screen.getByText('Limite para novas requisições: 67 tok/s')).toBeTruthy()
    expect(screen.getByText(/Respostas em andamento mantêm a velocidade/)).toBeTruthy()
    expect(screen.queryByText(/USD|US\$|budget/i)).toBeNull()
  })
  it('keeps the confirmed reading visible and provides a retry action after failure', () => {
    const input = props()
    render(<StaminaDisplay {...input} failed />)
    expect(screen.getByRole('status').textContent).toContain('última leitura confirmada')
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('50')
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(input.refreshStamina).toHaveBeenCalledOnce()
  })
  it('shows neither a bar nor invented full stamina while eligibility is unknown or disabled', () => {
    const input = props()
    const view = render(<StaminaDisplay {...input} rows={undefined} />)
    expect(view.container.textContent).toBe('')
    view.rerender(<StaminaDisplay {...input} rows={[]} />)
    expect(view.container.textContent).toBe('')
    view.rerender(<StaminaDisplay {...input} rows={[]} failed />)
    expect(view.container.textContent).toBe('')
    view.rerender(<StaminaDisplay {...input} rows={undefined} failed />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('temporariamente indisponível')
    view.rerender(<StaminaDisplay {...input} rows={undefined} failed compact />)
    expect(view.container.textContent).toBe('')
  })
  it('keeps zero stamina usable at the server-provided 5 TPS floor', () => {
    render(<StaminaDisplay {...props()} rows={[{ ...reading, remainingPercent: 0, nextOutputTps: 5, accountingPending: true }]} />)
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('0')
    expect(screen.getByText('Limite para novas requisições: 5 tok/s')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('uso está sendo confirmado')
  })
  it.each(['pt', 'en', 'zh'])('localizes the public reading and recovery in %s', (locale) => {
    const input = props(locale)
    render(<StaminaDisplay {...input} rows={[{ ...reading, recovering: true }]} />)
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('50')
    expect(screen.getByRole('region').textContent).toMatchSnapshot()
  })
  it('formats the server recovery time in the current locale', () => {
    const fullAt = '2026-11-04T16:30:00Z'
    render(<StaminaDisplay {...props()} rows={[{ ...reading, recovering: true, fullAt }]} />)
    const time = new Intl.DateTimeFormat('pt', { timeStyle: 'medium' }).format(new Date(fullAt))
    expect(screen.getByText(`Recarga completa prevista às ${time}`)).toBeTruthy()
  })
})
