// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { Plan, PlanId, Subscription } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { BillingState } from '../src/client/billing-model.ts'
import type { BillingQuoteId, BillingSubscriptionId, PlanChangeId } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ProductSnapshot } from '../src/client/model.ts'
import { PlanPage } from '../src/client/Plans.tsx'
import { en, pt, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
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
    view: null, profile: null, profilePreviouslyVerified: false, initialized: true, accountFailed: false, actionFailed: null,
    starting: false, plans: { subscriptions: [subscription()], catalog: [max, pro] },
    connections: null, plansFailed: false, connectionsFailed: false,
    loadingPlans: false, loadingConnections: false, busy: null, handoff: null,
    handoffUntil: 0, connectedTarget: null, feedback: null, modelFailed: false,
    initializingModel: false, browserBlocked: false, navigationFailed: false, authorizationIds: [],
    mcpServers: null, loadingMcp: false, mcpFailed: false, mcpProbe: null, probingMcp: false, mcpError: null,
  }
  const copy: Readonly<Record<string, string>> = locale === 'pt' ? pt : locale === 'zh' ? zh : en
  const billingState: BillingState = {
    selectedPlan: null, recommendation: null, offer: null, purchase: null, selectedSubscription: null,
    changeOffer: null, change: null, invoices: null, lifecycle: null, cancellation: null, busy: false, notice: null,
  }
  const props: ComponentProps<typeof PlanPage> = {
    useProduct: selector => selector(state),
    usePreferences: selector => selector({ locale, theme: 'system', languages: [] }),
    useBillingPanel: selector => selector(billingState),
    choosePurchase: vi.fn(), manageSubscription: vi.fn(), confirmPurchase: vi.fn(), reopenPurchase: vi.fn(),
    retryPurchase: vi.fn(), abandonPurchase: vi.fn(), openBillingTerms: vi.fn(), closePurchase: vi.fn(), refreshBilling: vi.fn(),
    previewPlanChange: vi.fn(), confirmPlanChange: vi.fn(),
    reviewSubscriptionAction: vi.fn(), updateSubscription: vi.fn(), loadBillingInvoices: vi.fn(),
    updateBillingCard: vi.fn(), openBillingPortal: vi.fn(), openBillingLink: vi.fn(),
    billing: vi.fn(), loadPlans: vi.fn(), start: vi.fn(),
    t: (key, values) => (copy[key] ?? key).replace(/\{(\w+)\}/g, (_match: string, name: string) => {
      const value = values?.[name]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
    }),
  }
  return { props, state, billingState }
}

describe('subscription comparison', () => {
  it('orders prices within each currency, marks the current plan and keeps server descriptions intact', () => {
    const { props, state } = fixture()
    state.plans!.catalog.push(plan('Lite', 9900))
    const view = render(<PlanPage {...props} />)
    expect([...view.container.querySelectorAll('[data-plan-id]')].map(el => el.getAttribute('data-plan-id'))).toEqual(['Lite', 'Pro', 'Max'])
    expect(screen.getByRole('button', { name: 'Plano atual: Pro' }).hasAttribute('disabled')).toBe(true)
    expect(within(view.container.querySelector('[data-plan-id="Lite"]') as HTMLElement).getByText('Uso limitado')).toBeTruthy()
    expect(screen.getByText('Description: Pro')).toBeTruthy()
    expect(screen.getByText(/499,00/)).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByText(/Recomendado|Popular/)).toBeNull()
  })

  it('keeps management and acquisition addressed to the selected server plan', () => {
    const { props } = fixture()
    render(<PlanPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Gerenciar assinatura: Pro' }))
    expect(props.manageSubscription).toHaveBeenLastCalledWith(subscription())
    fireEvent.click(screen.getByRole('button', { name: 'Escolher plano: Max' }))
    expect(props.choosePurchase).toHaveBeenLastCalledWith(max)
    fireEvent.click(screen.getByRole('button', { name: 'Plano atual: Pro' }))
    expect(props.choosePurchase).toHaveBeenCalledTimes(1)
  })

  it('folds ended subscriptions while keeping payment issues and unknown statuses visible', () => {
    const { props, state } = fixture()
    state.plans!.subscriptions = [subscription('canceled', 'Old'), subscription('past_due'), subscription('unpaid', 'Unpaid'), subscription('provider_status', 'Unknown')]
    const view = render(<PlanPage {...props} />)
    const historyButton = screen.getByRole('button', { name: new RegExp(pt.subscriptionHistory) })
    const history = view.container.ownerDocument.getElementById(historyButton.getAttribute('aria-controls')!)!
    expect(historyButton.getAttribute('aria-expanded')).toBe('false')
    expect(history.hasAttribute('inert')).toBe(true)
    expect(history.textContent).toContain('Old')
    expect(history.textContent).not.toContain('Próxima renovação')
    const owned = screen.getByRole('region', { name: 'Minha assinatura' })
    expect(within(owned).getByText('Pagamento pendente')).toBeTruthy()
    expect(within(owned).getByText('Pagamento necessário')).toBeTruthy()
    expect(within(owned).getByText('Verificar assinatura')).toBeTruthy()
    expect(within(owned).queryByText('Old')).toBeNull()
  })

  it('keeps historical invoice controls with the ended subscription that opened them', () => {
    const { props, state, billingState } = fixture()
    const ended = { ...subscription('canceled', 'Old'), canUpgrade: false,
      permissions: { invoices: true, cancel: false, reactivate: false, paymentMethod: false } }
    state.plans!.subscriptions.push(ended)
    const view = render(<PlanPage {...props} />)
    const historyButton = screen.getByRole('button', { name: new RegExp(pt.subscriptionHistory) })
    fireEvent.click(historyButton)
    const history = view.container.ownerDocument.getElementById(historyButton.getAttribute('aria-controls')!)!
    const trigger = within(history).getByRole('button', { name: 'Gerenciar assinatura: Old' })
    fireEvent.click(trigger)
    expect(props.manageSubscription).toHaveBeenCalledWith(ended)

    billingState.selectedSubscription = ended.id
    view.rerender(<PlanPage {...props} />)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const details = within(history).getByRole('region', { name: 'Old' })
    fireEvent.click(within(details).getByRole('button', { name: pt.billingInvoices }))
    expect(props.loadBillingInvoices).toHaveBeenCalledWith(ended.id)
    expect(within(screen.getByRole('dialog', { name: pt.billingInvoices })).getByText(ended.name)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Minha assinatura' })).queryByRole('region', { name: 'Old' })).toBeNull()
  })

  it('retries a failed invoice refresh while keeping the last loaded invoices visible', () => {
    const { props, state, billingState } = fixture()
    const active = state.plans!.subscriptions[0]!
    active.permissions = { invoices: true, cancel: false, reactivate: false, paymentMethod: false }
    billingState.selectedSubscription = active.id
    const invoice = {
      id: 'invoice-1', number: 'INV-001', created: '2026-11-04T12:00:00Z',
      amountDue: 24900, amountPaid: 24900, currency: 'BRL', status: 'paid', url: null,
    }
    billingState.invoices = [invoice]
    const view = render(<PlanPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: pt.billingInvoices }))
    const dialog = within(screen.getByRole('dialog', { name: pt.billingInvoices }))
    expect(dialog.queryByRole('button', { name: pt.retry })).toBeNull()

    billingState.notice = 'billingUnavailable'
    view.rerender(<PlanPage {...props} />)
    expect(dialog.getByText('INV-001')).toBeTruthy()
    expect(dialog.getByText(pt.billingUnavailable)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: pt.retry }))
    expect(props.loadBillingInvoices).toHaveBeenLastCalledWith(active.id)
    expect(props.loadBillingInvoices).toHaveBeenCalledTimes(2)

    billingState.notice = null
    billingState.invoices = [{ ...invoice, number: 'INV-002' }]
    view.rerender(<PlanPage {...props} />)
    expect(dialog.getByText('INV-002')).toBeTruthy()
    expect(dialog.queryByText('INV-001')).toBeNull()
    expect(dialog.queryByRole('button', { name: pt.retry })).toBeNull()
  })

  it('never presents a zero catalog price as a free offer', () => {
    const { props, state } = fixture()
    const unpriced = plan('Custom', 0)
    state.plans!.catalog.push(unpriced)
    render(<PlanPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ver preço atualizado: Custom' }))
    expect(props.choosePurchase).toHaveBeenLastCalledWith(unpriced)
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
    expect(props.choosePurchase).toHaveBeenLastCalledWith(annual)
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
    expect(screen.getByRole('alert').textContent).toContain(pt.readPlansTitle)
    expect(screen.getByRole('alert').textContent).toContain(pt.readStale)
    expect(screen.getByRole('status').textContent).toContain(pt.purchasePending)
    expect(screen.getByRole('button', { name: 'Escolher plano: Max' })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Atualizar' })[0]!)
    expect(props.loadPlans).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: pt.retry }))
    expect(props.loadPlans).toHaveBeenCalledTimes(2)
  })

  it('offers sign-in and retry when the account is signed out', () => {
    const { props, state } = fixture()
    state.plansFailed = true
    state.plansFailureReason = 'signed_out'
    render(<PlanPage {...props} />)
    expect(screen.getByRole('alert').textContent).toContain(pt.readAuthDescription)
    fireEvent.click(screen.getByRole('button', { name: pt.readSignIn }))
    expect(props.start).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: pt.retry }))
    expect(props.loadPlans).toHaveBeenCalledOnce()
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

  it('reviews the card amount and renewal in Plans before confirming', () => {
    const { props, billingState } = fixture()
    billingState.selectedPlan = max
    billingState.offer = {
      id: 'quote' as BillingQuoteId, planId: max.id, interval: 'month',
      initialAmountMinor: 29900, renewalAmountMinor: 49900, currency: 'BRL', expiresAt: '2026-12-04T12:00:00Z',
    }
    render(<PlanPage {...props} />)
    const checkout = screen.getByRole('region', { name: /Compra do plano/ })
    expect(within(checkout).getByText(/299,00/)).toBeTruthy()
    expect(within(checkout).getByText(/499,00/)).toBeTruthy()
    fireEvent.click(within(checkout).getByRole('button', { name: pt.billingConfirmCard }))
    expect(props.confirmPurchase).toHaveBeenCalledOnce()
    expect(props.billing).not.toHaveBeenCalled()
  })

  it('shows the plan details when billing actions are unavailable', () => {
    const { props, state, billingState } = fixture()
    const access = { ...subscription('active', 'Ultra'), canUpgrade: false, billing: null }
    state.plans!.subscriptions = [access]
    const view = render(<PlanPage {...props} />)
    const disclosure = screen.getByRole('button', { name: 'Ver detalhes da assinatura: Ultra' })
    fireEvent.click(disclosure)
    expect(props.manageSubscription).toHaveBeenCalledWith(access)

    billingState.selectedSubscription = access.id
    view.rerender(<PlanPage {...props} />)
    const details = within(screen.getByRole('region', { name: 'Ultra' }))
    expect(details.getByText('Ativo')).toBeTruthy()
    expect(details.getByText(pt.billingPeriodEnd)).toBeTruthy()
    expect(details.getByText(pt.billingNoActions)).toBeTruthy()
    expect(details.queryByRole('button', { name: pt.billingCancelSubscription })).toBeNull()
    expect(details.queryByRole('button', { name: pt.close })).toBeNull()
    fireEvent.click(disclosure)
    expect(props.manageSubscription).toHaveBeenLastCalledWith(null)
    expect(document.activeElement).toBe(disclosure)
    billingState.selectedSubscription = null
    view.rerender(<PlanPage {...props} />)
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(disclosure.getAttribute('aria-controls')!)?.hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('region', { name: 'Ultra' })).toBeNull()
  })

  it('shows invoices and cancellation access only for the selected subscription', () => {
    const { props, state, billingState } = fixture()
    const owned = state.plans!.subscriptions[0]!
    owned.permissions = { cancel: true, reactivate: false, invoices: true, paymentMethod: true }
    billingState.selectedSubscription = owned.id
    billingState.lifecycle = 'cancel'
    billingState.invoices = [{
      id: 'invoice', number: '001', created: '2026-11-04T12:00:00Z',
      amountDue: 24900, amountPaid: 24900, status: 'paid', currency: 'BRL', url: null,
    }]
    const view = render(<PlanPage {...props} />)
    const cancellation = within(screen.getByRole('dialog', { name: pt.billingCancelSubscription }))
    expect(cancellation.getByText(/Acesso até/)).toBeTruthy()
    expect(screen.queryByText(pt.billingInvoicePaid)).toBeNull()
    fireEvent.click(cancellation.getByRole('button', { name: pt.billingConfirmCancel }))
    expect(props.updateSubscription).toHaveBeenCalledWith(owned.id)
    billingState.lifecycle = null
    view.rerender(<PlanPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: pt.billingInvoices }))
    const invoices = within(screen.getByRole('dialog', { name: pt.billingInvoices }))
    expect(invoices.getByText(pt.billingInvoicePaid)).toBeTruthy()
    expect(invoices.queryByRole('button', { name: pt.billingPayInvoice })).toBeNull()
  })

  it('quotes plan changes from the subscription dialog without opening a provider page', () => {
    const { props, state, billingState } = fixture()
    const owned = state.plans!.subscriptions[0]!
    const lite = plan('Lite', 9900)
    state.plans!.catalog.push(lite)
    billingState.selectedSubscription = owned.id
    render(<PlanPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: pt.billingChangePlan }))
    const dialog = within(screen.getByRole('dialog', { name: pt.billingChangePlan }))
    fireEvent.click(dialog.getByRole('button', { name: /Lite.*Uso limitado/ }))
    expect(props.previewPlanChange).toHaveBeenCalledWith(owned.id, lite, false)
    expect(props.openBillingLink).not.toHaveBeenCalled()
  })

  it('keeps a plan change opened from the catalog visible through scheduled confirmation', () => {
    const { props, state, billingState } = fixture()
    const owned = state.plans!.subscriptions[0]!
    billingState.selectedSubscription = owned.id
    billingState.reviewingChange = true
    billingState.changeOffer = {
      id: 'quote' as BillingQuoteId, subscriptionId: owned.id as BillingSubscriptionId, targetPlanId: max.id,
      interval: 'month', currency: 'BRL', amountDueNowCents: 0, creditNowCents: 0,
      nextRenewalAt: '2026-12-04T12:00:00Z', effectiveAt: '2026-12-04T12:00:00Z', expiresAt: '2026-12-01T12:00:00Z',
      nextRenewalAmountCents: max.priceCents, undoesCancellation: false, removesConcurrencyTier: false,
    }
    const view = render(<PlanPage {...props} />)
    const dialog = within(screen.getByRole('dialog', { name: pt.billingChangePlan }))
    expect(dialog.getByText(/Novo plano · Max/)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: pt.billingConfirmChange }))
    expect(props.confirmPlanChange).toHaveBeenCalledOnce()
    billingState.changeOffer = null
    billingState.change = { id: 'change' as PlanChangeId, status: 'scheduled', effectiveAt: '2026-12-04T12:00:00Z', url: null }
    view.rerender(<PlanPage {...props} />)
    expect(dialog.getByText(/Troca de plano agendada/)).toBeTruthy()
    expect(props.openBillingLink).not.toHaveBeenCalled()
  })

  it('keeps a subscription mutation unavailable while its original response is reconciled', () => {
    const { props, state, billingState } = fixture()
    const owned = state.plans!.subscriptions[0]!
    owned.permissions = { cancel: true, reactivate: false, invoices: true, paymentMethod: true }
    billingState.selectedSubscription = owned.id
    billingState.lifecycleProgress = { action: 'cancel', status: 'unconfirmed', cancellation: null }
    render(<PlanPage {...props} />)
    const details = within(screen.getByRole('region', { name: owned.name }))
    expect(details.getByText(pt.billingUpdateUnconfirmed)).toBeTruthy()
    expect(details.queryByRole('button', { name: pt.billingCancelSubscription })).toBeNull()
    expect(details.getByRole('button', { name: pt.billingInvoices })).toBeTruthy()
    fireEvent.click(details.getByRole('button', { name: pt.refresh }))
    expect(props.refreshBilling).toHaveBeenCalledOnce()
  })

  it('changes the selected subscription card and shows the server-confirmed outcome', () => {
    const { props, state, billingState } = fixture()
    const owned = state.plans!.subscriptions[0]!
    owned.permissions = { cancel: true, reactivate: false, invoices: true, paymentMethod: true, cardUpdate: true }
    billingState.selectedSubscription = owned.id
    const screenView = render(<PlanPage {...props} />)
    const details = within(screen.getByRole('region', { name: owned.name }))
    const trigger = details.getByRole('button', { name: pt.billingChangeCard })
    trigger.focus()
    fireEvent.click(trigger)
    expect(props.updateBillingCard).not.toHaveBeenCalled()
    const dialog = within(screen.getByRole('dialog', { name: pt.billingChangeCard }))
    fireEvent.click(dialog.getByRole('button', { name: pt.billingOpenStripe }))
    expect(props.updateBillingCard).toHaveBeenCalledWith(owned.id)
    billingState.cardUpdate = { id: '00000000-0000-4000-8000-000000000040', status: 'pending', url: null }
    screenView.rerender(<PlanPage {...props} />)
    expect(dialog.getByText(pt.billingCardUpdatePending)).toBeTruthy()
    expect(dialog.queryByText(pt.billingCardUpdated)).toBeNull()
    expect(dialog.getByRole('button', { name: pt.billingOpenStripe })).toBeTruthy()
    billingState.cardUpdate = { ...billingState.cardUpdate, status: 'confirmed' }
    screenView.rerender(<PlanPage {...props} />)
    expect(dialog.getByText(pt.billingCardUpdated)).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: pt.billingChangeCard })).toBeNull()
    expect(dialog.getByText(pt.billingCardUpdated).closest('[inert]')).not.toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    const reopened = within(screen.getByRole('dialog', { name: pt.billingChangeCard }))
    expect(reopened.queryByText(pt.billingCardUpdated)).toBeNull()
    expect(reopened.getByRole('button', { name: pt.billingOpenStripe })).toBeTruthy()
  })

  it('opens the native card form once and waits for the server after submission', () => {
    const { props, state, billingState } = fixture()
    const owned = state.plans!.subscriptions[0]!
    owned.permissions = { cancel: true, reactivate: false, invoices: true, paymentMethod: true, cardUpdate: true }
    billingState.selectedSubscription = owned.id
    vi.stubGlobal('__VERBOO_DESKTOP__', { openCardSetup: vi.fn() })
    const view = render(<PlanPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: pt.billingChangeCard }))
    const modal = within(screen.getByRole('dialog', { name: pt.billingChangeCard }))
    expect(props.updateBillingCard).toHaveBeenCalledWith(owned.id, expect.objectContaining({ title: pt.billingChangeCard }))
    expect(modal.queryByRole('button', { name: pt.billingOpenStripe })).toBeNull()

    billingState.cardUpdate = { id: 'fake-operation', status: 'pending', url: null }
    billingState.cardAwaitingConfirmation = true
    view.rerender(<PlanPage {...props} />)
    expect(modal.getByText(pt.billingProcessing)).toBeTruthy()
    expect(modal.queryByText(pt.billingCardUpdated)).toBeNull()
    expect(props.updateBillingCard).toHaveBeenCalledOnce()
    expect(props.openBillingLink).not.toHaveBeenCalled()
  })

  it.each(['pt', 'en', 'zh'])('localizes the comparison and billing controls in %s', (locale) => {
    const { props, state } = fixture(locale)
    state.plans!.catalog.push(annual)
    const view = render(<PlanPage {...props} />)
    expect(view.container.textContent).toMatchSnapshot()
  })
})
