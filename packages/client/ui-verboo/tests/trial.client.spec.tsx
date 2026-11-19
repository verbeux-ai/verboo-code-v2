// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PlanId, TrialId, TrialOfferId, TrialAttemptId } from '@deepseek-ai/dsh-api-verboo-product/types'
import { TrialModal, TrialDock } from '../src/client/Trial.tsx'
import type { TrialSnapshot } from '../src/client/trial-model.ts'
import type { ProductSnapshot } from '../src/client/model.ts'
import { en, pt, zh } from '../src/client/locales.ts'
afterEach(cleanup)
function fixture(locale = 'pt') {
  const state: TrialSnapshot = {
    notices: [{ id: 'trial' as TrialId, groupId: 'pro' as never, source: 'free_tokens', state: 'ended', tokensRemaining: 0 }],
    open: true,
    loading: false,
    stale: false,
    quoting: false,
    paying: false,
    error: null,
    payment: null,
    offer: {
      id: 'quote' as TrialOfferId,
      paymentMethod: 'card',
      pixAvailable: true,
      planId: 'pro' as never,
      name: 'Pro',
      amountMinor: 6900,
      renewalAmountMinor: 6900,
      currency: 'USD',
      interval: 'month',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      card: { brand: 'visa', last4: '4242' },
      methods: ['card'],
    },
  }
  const dictionary = locale === 'pt' ? pt : locale === 'zh' ? zh : en
  const product: ProductSnapshot = {
    view: null, profile: { id: null, name: null, contact: null }, profilePreviouslyVerified: true, initialized: true,
    accountFailed: false, actionFailed: null, starting: false, connections: null, plansFailed: false, connectionsFailed: false,
    loadingPlans: false, loadingConnections: false, busy: null, handoff: null, handoffUntil: 0, connectedTarget: null,
    feedback: null, modelFailed: false, initializingModel: false, browserBlocked: false, navigationFailed: false,
    authorizationIds: [], mcpServers: null, loadingMcp: false, mcpFailed: false, mcpProbe: null, probingMcp: false, mcpError: null,
    plans: {
      subscriptions: [], catalog: [
        {
          id: 'max' as PlanId,
          slug: 'max',
          name: 'Max',
          description: 'More parallel projects',
          currency: 'USD',
          priceCents: 12900,
          interval: 'month',
        },
        {
          id: 'pro' as PlanId,
          slug: 'pro',
          name: 'Pro',
          description: 'Daily coding projects',
          currency: 'USD',
          priceCents: 6900,
          interval: 'month',
        },
        { id: 'ultra' as PlanId, slug: 'ultra', name: 'Ultra', description: 'More capacity', currency: 'USD', priceCents: 25900, interval: 'month' },
        { id: 'lite' as PlanId, slug: 'lite', name: 'Lite', description: 'Limited access', currency: 'USD', priceCents: 2000, interval: 'month' },
        { id: 'qwen' as PlanId, slug: 'qwen', name: 'Qwen 3.8 Max', description: 'Usage based', currency: 'USD', priceCents: 0, interval: 'month' },
      ],
    },
  }
  const props: ComponentProps<typeof TrialModal> & Pick<ComponentProps<typeof TrialDock>, 'useStaminaModel'> = {
    useTrial: select => select(state),
    useProduct: select => select(product),
    usePreferences: select => select({ locale, theme: 'system', languages: [] }),
    useNavigation: select => select([]),
    useExternalStatus: select => select({ signedIn: false }),
    t: (key, params) =>
      (dictionary as Record<string, string>)[key]?.replace(/\{(\w+)\}/g, (_, name: string) => {
        const value = params?.[name]
        return typeof value === 'string' || typeof value === 'number' ? String(value) : name
      }) ?? key,
    useStaminaModel: select => select({ current: null }),
    selectTrialGroup: vi.fn(),
    loadPlans: vi.fn(),
    showTrial: vi.fn(),
    closeTrial: vi.fn(),
    quoteTrial: vi.fn(),
    confirmTrial: vi.fn(),
    refreshTrial: vi.fn(),
    reopenTrial: vi.fn(),
    start: vi.fn(), reopen: vi.fn(), cancel: vi.fn(), retryAccount: vi.fn(), signOut: vi.fn(async () => true),
    startSession: vi.fn(), openSession: vi.fn(), openWorkspace: vi.fn(), addProject: vi.fn(async () => {}),
    renameProject: vi.fn(async () => {}), removeProject: vi.fn(async () => {}), sessionMenu: vi.fn(),
    selectPanel: vi.fn(), toggleSidebar: vi.fn(), loadConnections: vi.fn(), beginOpenAiSignIn: vi.fn(async () => undefined),
    completeOpenAiSignIn: vi.fn(async () => true), openAiStatus: vi.fn(async () => ({ signedIn: false })),
    signOutOpenAi: vi.fn(async () => {}), refreshSubscriptionUsage: vi.fn(), openOpenAiDialog: vi.fn(),
    closeOpenAiDialog: vi.fn(), refreshStamina: vi.fn(), connect: vi.fn(async () => true), reopenConnection: vi.fn(),
    disconnect: vi.fn(async () => true), loadMcpServers: vi.fn(), saveMcpServer: vi.fn(async () => true),
    deleteMcpServer: vi.fn(async () => true), setMcpEnabled: vi.fn(async () => true), probeMcpServer: vi.fn(async () => true),
    clearMcpProbe: vi.fn(), billing: vi.fn(), dismiss: vi.fn(), setTheme: vi.fn(), setLocale: vi.fn(), retryModel: vi.fn(), help: vi.fn(),
  }
  return { state, props, product }
}
describe('trial conversion interface', () => {
  it('offers only Pro, Max and Ultra in that order', () => {
    const f = fixture()
    render(<TrialModal {...f.props} />)
    const choices = screen.getAllByRole('button').filter(button => button.hasAttribute('aria-pressed'))
    expect(choices.map(button => button.querySelector('strong')?.textContent)).toEqual(['Pro', 'Max', 'Ultra'])
    expect(choices.map(button => button.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Stamina 1 de 3'),
      expect.stringContaining('Stamina 2 de 3'),
      expect.stringContaining('Stamina 3 de 3'),
    ]))
    expect(screen.queryByText('Lite')).toBeNull()
    expect(screen.queryByText('Qwen 3.8 Max')).toBeNull()
    fireEvent.click(choices[1]!)
    expect(f.props.quoteTrial).toHaveBeenCalledWith('max')
  })
  it.each(['pt', 'en', 'zh'])('shows USD prices, masked card, comparison and explicit authorization in %s', (locale) => {
    const f = fixture(locale)
    render(<TrialModal {...f.props} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('USD')
    expect(dialog.textContent).toContain('4242')
    expect(dialog.textContent).toContain('Pro')
    expect(dialog.textContent).toContain('Max')
    expect(f.props.confirmTrial).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(f.props.closeTrial).toHaveBeenCalledOnce()
  })
  it('requests an exact BRL offer before allowing Pix authorization', () => {
    const f = fixture()
    const view = render(<TrialModal {...f.props} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Forma de pagamento' }), { target: { value: 'pix' } })
    expect(f.props.quoteTrial).toHaveBeenCalledWith('pro', 'pix')
    expect(f.props.confirmTrial).not.toHaveBeenCalled()
    f.state.offer = {
      ...f.state.offer!,
      paymentMethod: 'pix',
      currency: 'BRL',
      amountMinor: 34900,
      renewalAmountMinor: 34900,
      card: null,
      methods: ['pix'],
      pixMandateAmountMinor: 36122,
    }
    view.rerender(<TrialModal {...f.props} />)
    expect(screen.getByRole('dialog').textContent).toContain('BRL')
    fireEvent.click(screen.getByRole('button', { name: /Assinar plano/ }))
    expect(f.props.confirmTrial).toHaveBeenCalledWith('pix')
  })
  it('offers recovery without another payment button while confirmation is pending', () => {
    const f = fixture()
    f.state.payment = { status: 'requires_action', attemptId: 'original' as TrialAttemptId, url: 'https://checkout.stripe.com/original' }
    render(<TrialModal {...f.props} />)
    expect(screen.queryByRole('button', { name: /Assinar plano/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retomar pagamento' }))
    expect(f.props.reopenTrial).toHaveBeenCalledOnce()
  })
  it('loads the plans and requests a quote without authorizing payment', () => {
    const f = fixture()
    f.state.offer = null
    render(<TrialModal {...f.props} />)
    expect(f.props.loadPlans).toHaveBeenCalledOnce()
    expect(f.props.quoteTrial).toHaveBeenCalledWith('pro')
    expect(f.props.confirmTrial).not.toHaveBeenCalled()
  })
  it('prevents confirmation of an expired or stale offer and allows refreshing it', () => {
    const f = fixture()
    f.state.offer!.expiresAt = '2000-01-01T00:00:00Z'
    f.state.stale = true
    render(<TrialModal {...f.props} />)
    expect(screen.getByRole('button', { name: /Assinar plano/ })).toHaveProperty('disabled', true)
    expect(f.props.confirmTrial).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: f.props.t('retry') }))
    expect(f.props.refreshTrial).toHaveBeenCalledOnce()
  })
  it.each(['quote', 'payment', 'navigation', 'unconfirmed'] as const)(
    'offers the right recovery action after a %s error', (error) => {
      const f = fixture()
      f.state.error = error
      render(<TrialModal {...f.props} />)
      expect(screen.getByRole('alert')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: f.props.t('retry') }))
      if (error === 'quote' || error === 'payment') expect(f.props.quoteTrial).toHaveBeenCalledWith('pro')
      else expect(f.props.refreshTrial).toHaveBeenCalledOnce()
    },
  )
  it('does not charge again while setup is pending and allows checking its status', () => {
    const f = fixture()
    f.state.payment = { status: 'setup_required', attemptId: 'original' as TrialAttemptId, url: null }
    render(<TrialModal {...f.props} />)
    expect(screen.queryByRole('button', { name: /Assinar plano/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: f.props.t('trialCheckPayment') }))
    expect(f.props.refreshTrial).toHaveBeenCalledOnce()
    expect(f.props.confirmTrial).not.toHaveBeenCalled()
  })
  it('hides the modal until the trial is open', () => {
    const f = fixture()
    f.state.open = false
    render(<TrialModal {...f.props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.props.loadPlans).not.toHaveBeenCalled()
  })
  it('offers a catalog retry instead of a payment when no supported plan is available', () => {
    const f = fixture()
    f.product.plans = null
    f.state.offer = null
    render(<TrialModal {...f.props} />)
    expect(screen.getByText(f.props.t('trialCatalogUnavailable'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: f.props.t('retry') }))
    expect(f.props.loadPlans).toHaveBeenCalledTimes(2)
    expect(f.props.confirmTrial).not.toHaveBeenCalled()
  })
  it('shows a card checkout when no saved card is available and Pix is unavailable', () => {
    const f = fixture()
    f.state.offer!.card = null
    f.state.offer!.pixAvailable = false
    f.state.offer!.interval = 'year'
    render(<TrialModal {...f.props} />)
    expect(screen.getByText(f.props.t('trialPixUnavailable'))).toBeTruthy()
    expect(screen.queryByRole('option', { name: f.props.t('trialPayPix') })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /cartão/i }))
    expect(f.props.confirmTrial).toHaveBeenCalledWith('card')
  })
  it('does not show a balance notice for a group with an active paid plan', () => {
    const f = fixture()
    f.state.paidGroupIds = ['pro' as PlanId]
    f.props.useStaminaModel = select => select({ current: { provider: 'deepseek-account', model: 'pro/flash' } })
    render(<TrialDock {...(f.props as ComponentProps<typeof TrialDock>)} />)
    expect(screen.queryByRole('button', { name: f.props.t('trialUpgrade') })).toBeNull()
  })
  it('offers a refresh in the composer when the trial status is stale', () => {
    const f = fixture()
    f.state.stale = true
    render(<TrialDock {...(f.props as ComponentProps<typeof TrialDock>)} />)
    fireEvent.click(screen.getByRole('button', { name: f.props.t('trialStale') }))
    expect(f.props.refreshTrial).toHaveBeenCalledOnce()
  })
  it('uses the selected model group balance when it is still on trial', () => {
    const f = fixture()
    f.state.paidGroupIds = []
    f.state.allNotices = [{ id: 'selected' as TrialId, groupId: 'pro' as PlanId, source: 'free_tokens', state: 'ending' }]
    f.props.useStaminaModel = select => select({ current: { provider: 'deepseek-account', model: 'pro/flash' } })
    render(<TrialDock {...(f.props as ComponentProps<typeof TrialDock>)} />)
    expect(screen.getByText(f.props.t('trialEnding'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: f.props.t('trialUpgrade') }))
    expect(f.props.selectTrialGroup).toHaveBeenCalledWith('pro')
  })
  it('shows progress and disables confirmation while payment is being processed', () => {
    const f = fixture()
    f.state.paying = true
    f.state.quoting = true
    render(<TrialModal {...f.props} />)
    expect(screen.getByText(f.props.t('trialQuoting'))).toBeTruthy()
    expect(screen.getByRole('button', { name: f.props.t('trialProcessing') })).toHaveProperty('disabled', true)
    expect(f.props.confirmTrial).not.toHaveBeenCalled()
  })
  it('falls back to the selected group notice when the complete list is absent', () => {
    const f = fixture()
    f.state.paidGroupIds = []
    delete f.state.allNotices
    f.props.useStaminaModel = select => select({ current: { provider: 'deepseek-account', model: 'pro/flash' } })
    render(<TrialDock {...(f.props as ComponentProps<typeof TrialDock>)} />)
    expect(screen.getByText(/tokens restantes/)).toBeTruthy()
  })
  it('recognizes a legacy plan by name and renders yearly prices without a token balance', () => {
    const f = fixture()
    const plan = f.product.plans!.catalog.find(item => item.name === 'Pro')!
    delete plan.slug
    plan.interval = 'year'
    delete f.state.notices[0]!.tokensRemaining
    f.state.notices[0]!.state = 'ending'
    f.state.offer = null
    render(<TrialModal {...f.props} />)
    expect(f.props.quoteTrial).toHaveBeenCalledWith('pro')
    expect(screen.queryByText(/tokens restantes/)).toBeNull()
    expect(screen.getByText(f.props.t('yearly'))).toBeTruthy()
  })
  it('ignores invalid payment method changes', () => {
    const f = fixture()
    render(<TrialModal {...f.props} />)
    fireEvent.change(screen.getByRole('combobox', { name: f.props.t('trialPaymentMethod') }), { target: { value: 'invalid' } })
    expect(f.props.quoteTrial).not.toHaveBeenCalled()
  })
  it('puts the actual remaining token count next to the composer without a modal', () => {
    const f = fixture()
    f.state.open = false
    f.state.notices[0]!.tokensRemaining = 800000
    render(<TrialDock {...(f.props as ComponentProps<typeof TrialDock>)} />)
    expect(screen.getByText(/800.000 tokens restantes/)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fazer upgrade' }))
    expect(f.props.showTrial).toHaveBeenCalledOnce()
  })
})
