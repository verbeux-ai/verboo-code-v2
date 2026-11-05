// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { Plan, PlanId, Subscription } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ProductSnapshot } from '../src/client/model.ts'
import { PlanPage } from '../src/client/Plans.tsx'
import { en, pt, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const plan = (name: string, priceCents: number, interval = 'month'): Plan => ({
  id: name as PlanId, name, description: `Description: ${name}`, priceCents, currency: 'BRL', interval,
})
const pro = plan('Pro', 24900)
const max = plan('Max', 49900)
const annual = plan('Pro annual', 249000, 'year')
const subscription = (status = 'active', name = 'Pro'): Subscription => ({
  id: `subscription-${name}`, planId: name as PlanId, name, status,
  renewsAt: '2026-12-04T12:00:00Z', cancelAtEnd: false, canUpgrade: true,
  billing: { amountMinor: 24900, currency: 'BRL', interval: 'month' },
})
function fixture(locale = 'pt') {
  const state: ProductSnapshot = {
    view: null, profile: null, initialized: true, accountFailed: false, actionFailed: null,
    starting: false, plans: { subscriptions: [subscription()], catalog: [max, pro] },
    connections: null, plansFailed: false, connectionsFailed: false,
    loadingPlans: false, loadingConnections: false, busy: null, handoff: null,
    handoffUntil: 0, connectedTarget: null, feedback: null, modelFailed: false,
    initializingModel: false, browserBlocked: false, navigationFailed: false, authorizationIds: [],
  }
  const copy: Readonly<Record<string, string>> = locale === 'pt' ? pt : locale === 'zh' ? zh : en
  const props: ComponentProps<typeof PlanPage> = {
    useProduct: selector => selector(state),
    usePreferences: selector => selector({ locale, theme: 'system', languages: [] }),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
    billing: vi.fn(), loadPlans: vi.fn(), refreshStamina: vi.fn(),
    t: (key, values) => (copy[key] ?? key).replace(/\{(\w+)\}/g, (_match: string, name: string) => {
      const value = values?.[name]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    }),
  }
  return { props, state }
}

describe('subscription comparison', () => {
  it('orders prices within each currency, marks the current plan and keeps server descriptions intact', () => {
    const { props, state } = fixture()
    state.plans!.catalog.push(plan('Lite', 9900))
    const view = render(<PlanPage {...props} />)
    expect([...view.container.querySelectorAll('[data-plan-id]')].map(el => el.getAttribute('data-plan-id'))).toEqual(['Lite', 'Pro', 'Max'])
    expect(screen.getByRole('button', { name: 'Plano atual: Pro' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Description: Pro')).toBeTruthy()
    expect(screen.getByText(/499,00/)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByText(/Recomendado|Popular/)).toBeNull()
  })

  it('keeps management and acquisition addressed to the selected server plan', () => {
    const { props } = fixture()
    render(<PlanPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Gerenciar assinatura: Pro' }))
    expect(props.billing).toHaveBeenLastCalledWith(pro.id, false)
    fireEvent.click(screen.getByRole('button', { name: 'Escolher plano: Max' }))
    expect(props.billing).toHaveBeenLastCalledWith(max.id, true)
    fireEvent.click(screen.getByRole('button', { name: 'Plano atual: Pro' }))
    expect(props.billing).toHaveBeenCalledTimes(2)
  })

  it('folds ended subscriptions while keeping payment issues and unknown statuses visible', () => {
    const { props, state } = fixture()
    state.plans!.subscriptions = [subscription('canceled', 'Old'), subscription('past_due'), subscription('unpaid', 'Unpaid'), subscription('provider_status', 'Unknown')]
    const view = render(<PlanPage {...props} />)
    const history = view.container.querySelector('details')!
    expect(history.open).toBe(false)
    expect(history.textContent).toContain('Old')
    expect(history.textContent).not.toContain('Próxima renovação')
    const owned = screen.getByRole('region', { name: 'Suas assinaturas' })
    expect(within(owned).getByText('Pagamento pendente')).toBeTruthy()
    expect(within(owned).getByText('Pagamento necessário')).toBeTruthy()
    expect(within(owned).getByText('Verificar assinatura')).toBeTruthy()
    expect(within(owned).queryByText('Old')).toBeNull()
  })

  it('never presents a zero catalog price as a free offer', () => {
    const { props, state } = fixture()
    const unpriced = plan('Custom', 0)
    state.plans!.catalog.push(unpriced)
    render(<PlanPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver preço atualizado: Custom' }))
    expect(props.billing).toHaveBeenLastCalledWith(unpriced.id, true)
    expect(screen.queryByText(/^R\$\s*0,00/)).toBeNull()
    expect(screen.queryByText(/Grátis|Gratuito/)).toBeNull()
  })

  it('compares only real billing periods and supports keyboard selection without changing annual prices', () => {
    const { props, state } = fixture()
    state.plans!.catalog.push(annual)
    const view = render(<PlanPage {...props} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Mensal' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Anual' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').id).toBe('verboo-billing-year-panel')
    expect(screen.queryByRole('button', { name: 'Escolher plano: Max' })).toBeNull()
    expect(screen.getByText(/2\.490,00/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Escolher plano: Pro annual' }))
    expect(props.billing).toHaveBeenLastCalledWith(annual.id, true)
    state.plans = { subscriptions: [], catalog: [max] }
    view.rerender(<PlanPage {...props} />)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('button', { name: 'Escolher plano: Max' })).toBeTruthy()
    expect(screen.queryByText('Pro annual')).toBeNull()
    expect(props.loadPlans).not.toHaveBeenCalled()
  })

  it('retains confirmed plans after refresh failures and never treats a browser handoff as payment', () => {
    const { props, state } = fixture()
    state.plansFailed = true
    state.handoff = 'billing'
    render(<PlanPage {...props} />)
    expect(screen.getByRole('alert').textContent).toContain(pt.unavailable)
    expect(screen.getByRole('status').textContent).toContain(pt.purchasePending)
    expect(screen.getByRole('button', { name: 'Escolher plano: Max' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Atualizar' })[0]!)
    expect(props.loadPlans).toHaveBeenCalledOnce()
    expect(props.refreshStamina).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: pt.retry }))
    expect(props.loadPlans).toHaveBeenCalledTimes(2)
  })

  it('does not invent a plan before the first response and gives an empty catalog a working destination', () => {
    const { props, state } = fixture()
    state.plans = null
    state.loadingPlans = true
    const view = render(<PlanPage {...props} />)
    expect(screen.getByRole('status', { name: pt.loading })).toBeTruthy()
    expect(screen.queryByText(pt.noPlan)).toBeNull()
    state.loadingPlans = false
    state.plans = { subscriptions: [], catalog: [] }
    view.rerender(<PlanPage {...props} />)
    expect(screen.getByText(pt.plansEmpty)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: pt.viewPlansWebsite }))
    expect(props.billing).toHaveBeenLastCalledWith(null, false)
  })

  it.each(['pt', 'en', 'zh'])('localizes the comparison and billing controls in %s', (locale) => {
    const { props, state } = fixture(locale)
    state.plans!.catalog.push(annual)
    const view = render(<PlanPage {...props} />)
    expect(view.container.textContent).toMatchSnapshot()
  })
})
