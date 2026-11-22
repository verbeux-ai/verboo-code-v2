// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PlanId, TrialId, TrialOfferId, TrialAttemptId } from '@deepseek-ai/dsh-api-verboo-product/types'
import { TrialModal, TrialDock } from '../src/client/Trial.tsx'
import type { TrialSnapshot } from '../src/client/trial-model.ts'
import type { OpenAiStatus, PreferenceSnapshot } from '../src/client/contracts.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ProductSnapshot } from '../src/client/model.ts'
import type { AccountProfile } from '@deepseek-ai/dsh-deepseek-account/types'
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
    view: null,
    profile: { id: 'owner' } as AccountProfile,
    profilePreviouslyVerified: true,
    initialized: true,
    accountFailed: false,
    actionFailed: null,
    starting: false,
    connections: null,
    plansFailed: false,
    connectionsFailed: false,
    loadingPlans: false,
    loadingConnections: false,
    busy: null,
    handoff: null,
    handoffUntil: 0,
    connectedTarget: null,
    feedback: null,
    modelFailed: false,
    initializingModel: false,
    browserBlocked: false,
    navigationFailed: false,
    authorizationIds: [],
    mcpServers: null,
    loadingMcp: false,
    mcpFailed: false,
    mcpProbe: null,
    probingMcp: false,
    mcpError: null,
    plans: {
      subscriptions: [],
      catalog: [
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
      ],
    },
  }
  type TrialFixture = ComponentProps<typeof TrialModal> & Pick<ComponentProps<typeof TrialDock>, 'useStaminaModel'>
  const props: TrialFixture = {
    useTrial: <T,>(select: (s: TrialSnapshot) => T): T => select(state),
    useProduct: <T,>(select: (s: typeof product) => T): T => select(product),
    useStaminaModel: <T,>(select: (s: { current: null }) => T): T => select({ current: null }),
    useNavigation: <T,>(select: (s: readonly { id: MainPanelId; label: string }[]) => T): T =>
      select([]),
    useExternalStatus: <T,>(select: (s: OpenAiStatus) => T): T => select({ signedIn: false }),
    usePreferences: <T,>(select: (s: PreferenceSnapshot) => T): T =>
      select({ theme: 'system', locale, languages: [] }),
    t: ((key: string, params: Record<string, string> = {}) =>
      (dictionary as Record<string, string>)[key]?.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? name) ??
      key) as TrialFixture['t'],
    selectTrialGroup: vi.fn(),
    start: vi.fn(),
    reopen: vi.fn(),
    cancel: vi.fn(),
    retryAccount: vi.fn(),
    signOut: vi.fn(async () => true),
    startSession: vi.fn(),
    openSession: vi.fn(),
    openWorkspace: vi.fn(),
    addProject: vi.fn(async () => undefined),
    renameProject: vi.fn(async () => undefined),
    removeProject: vi.fn(async () => undefined),
    sessionMenu: vi.fn(),
    selectPanel: vi.fn(),
    toggleSidebar: vi.fn(),
    loadConnections: vi.fn(),
    beginOpenAiSignIn: vi.fn(async () => undefined),
    completeOpenAiSignIn: vi.fn(async () => false),
    openAiStatus: vi.fn(async () => ({ signedIn: false })),
    signOutOpenAi: vi.fn(async () => undefined),
    refreshSubscriptionUsage: vi.fn(),
    openOpenAiDialog: vi.fn(),
    closeOpenAiDialog: vi.fn(),
    refreshStamina: vi.fn(),
    connect: vi.fn(async () => true),
    reopenConnection: vi.fn(),
    disconnect: vi.fn(async () => true),
    loadMcpServers: vi.fn(),
    saveMcpServer: vi.fn(async () => true),
    deleteMcpServer: vi.fn(async () => true),
    setMcpEnabled: vi.fn(async () => true),
    probeMcpServer: vi.fn(async () => true),
    signInMcpServer: vi.fn(async () => true),
    setMcpToken: vi.fn(async () => true),
    signOutMcpServer: vi.fn(async () => true),
    clearMcpProbe: vi.fn(),
    billing: vi.fn(),
    dismiss: vi.fn(),
    setTheme: vi.fn(),
    setLocale: vi.fn(),
    retryModel: vi.fn(),
    help: vi.fn(),
    loadPlans: vi.fn(),
    showTrial: vi.fn(),
    closeTrial: vi.fn(),
    quoteTrial: vi.fn(),
    confirmTrial: vi.fn(),
    refreshTrial: vi.fn(),
    reopenTrial: vi.fn(),
  }
  return { state, props }
}
describe('trial conversion interface', () => {
  it.each(['pt', 'en', 'zh'])('shows USD prices, masked card, comparison and explicit authorization in %s', (locale) => {
    const f = fixture(locale)
    render(<TrialModal {...f.props} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('USD')
    expect(dialog.textContent).toContain('4242')
    expect(dialog.textContent).toContain('Daily coding projects')
    expect(dialog.textContent).toContain('More parallel projects')
    expect(f.props.confirmTrial).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(f.props.closeTrial).toHaveBeenCalledOnce()
  })
  it('requests an exact BRL offer before allowing Pix authorization', () => {
    const f = fixture()
    const view = render(<TrialModal {...f.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pagar com Pix' }))
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
    fireEvent.click(screen.getByRole('button', { name: /Confirmar e pagar/ }))
    expect(f.props.confirmTrial).toHaveBeenCalledWith('pix')
  })
  it('offers recovery without another payment button while confirmation is pending', () => {
    const f = fixture()
    f.state.payment = { status: 'requires_action', attemptId: 'original' as TrialAttemptId, url: 'https://checkout.stripe.com/original' }
    render(<TrialModal {...f.props} />)
    expect(screen.queryByRole('button', { name: /Confirmar e pagar/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retomar pagamento' }))
    expect(f.props.reopenTrial).toHaveBeenCalledOnce()
  })
  it('puts the actual remaining token count next to the composer without a modal', () => {
    const f = fixture()
    f.state.open = false
    f.state.notices[0]!.tokensRemaining = 800000
    render(<TrialDock {...(f.props as unknown as ComponentProps<typeof TrialDock>)} />)
    expect(screen.getByText(/800.000 tokens restantes/)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fazer upgrade' }))
    expect(f.props.showTrial).toHaveBeenCalledOnce()
  })
})
