// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { PlanId, TrialId, TrialOfferId, TrialAttemptId } from '@deepseek-ai/dsh-api-verboo-product/types'
import { TrialModal, TrialDock } from '../src/client/Trial.tsx'
import type { TrialSnapshot } from '../src/client/trial-model.ts'
import type { ProductInjected } from '../src/client/contracts.ts'
import type { ProductSnapshot } from '../src/client/model.ts'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en, pt, zh } from '../src/client/locales.ts'
afterEach(cleanup)
type TrialFixtureProps = ComponentProps<typeof TrialModal> & ComponentProps<typeof TrialDock>
const noOp = (..._args: unknown[]): void => {}
const unexpectedSessionRuntime = (): never => { throw new Error('unexpected use of session runtime props') }
const falseSync = (..._args: unknown[]): boolean => false
const inputActions: InputActions = {
  insertQuote: falseSync,
  captureInsertion: unexpectedSessionRuntime,
  insertText: falseSync,
  setDraft: noOp,
  persistDraft: noOp,
  addAttachments: falseSync,
  removeAttachment: noOp,
  pruneAttachments: noOp,
  submit: noOp,
}
const noOpAsync = async (..._args: unknown[]): Promise<void> => {}
const falseAsync = async (..._args: unknown[]): Promise<boolean> => false
const noSignInAsync = async (): Promise<undefined> => undefined
const noOpenAiStatusAsync = async () => ({ signedIn: false })
const productActions: Omit<ProductInjected, 'hooks'> = {
  start: noOp,
  reopen: noOp,
  cancel: noOp,
  retryAccount: noOp,
  signOut: falseAsync,
  startSession: noOp,
  openSession: noOp,
  openWorkspace: noOp,
  addProject: noOpAsync,
  renameProject: noOpAsync,
  removeProject: noOpAsync,
  sessionMenu: noOp,
  selectPanel: noOp,
  toggleSidebar: noOp,
  loadPlans: noOp,
  loadConnections: noOp,
  beginOpenAiSignIn: noSignInAsync,
  completeOpenAiSignIn: falseAsync,
  openAiStatus: noOpenAiStatusAsync,
  signOutOpenAi: noOpAsync,
  refreshSubscriptionUsage: noOp,
  openOpenAiDialog: noOp,
  closeOpenAiDialog: noOp,
  refreshStamina: noOp,
  connect: falseAsync,
  reopenConnection: noOp,
  disconnect: falseAsync,
  loadMcpServers: noOp,
  saveMcpServer: falseAsync,
  deleteMcpServer: falseAsync,
  setMcpEnabled: falseAsync,
  probeMcpServer: falseAsync,
  clearMcpProbe: noOp,
  billing: noOp,
  dismiss: noOp,
  setTheme: noOp,
  setLocale: noOp,
  retryModel: noOp,
  help: noOp,
}
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
    profile: { id: null, name: 'Owner', contact: null },
    profilePreviouslyVerified: false,
    initialized: true,
    accountFailed: false,
    actionFailed: null,
    starting: false,
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
  }
  const props: TrialFixtureProps = {
    ...productActions,
    useTrial: select => select(state),
    useProduct: select => select(product),
    usePreferences: select => select({ locale, theme: 'system', languages: [] }),
    useNavigation: select => select([]),
    useExternalStatus: select => select({ signedIn: false }),
    useStaminaModel: select => select({ current: null }),
    useSession: unexpectedSessionRuntime,
    sessionId: 'trial-test' as SessionId,
    useProjection: unexpectedSessionRuntime,
    useAccess: unexpectedSessionRuntime,
    useConversation: unexpectedSessionRuntime,
    useInput: unexpectedSessionRuntime,
    inputActions,
    useChat: unexpectedSessionRuntime,
    useTrajectory: unexpectedSessionRuntime,
    useWorkspaces: unexpectedSessionRuntime,
    usePanelInfo: unexpectedSessionRuntime,
    useRemoteAccess: unexpectedSessionRuntime,
    useSessions: unexpectedSessionRuntime,
    useSessionStatus: unexpectedSessionRuntime,
    useSessionRetainInfo: unexpectedSessionRuntime,
    useSessionAccess: unexpectedSessionRuntime,
    useResource: unexpectedSessionRuntime,
    useContextMenu: unexpectedSessionRuntime,
    useWorkspaceAccess: unexpectedSessionRuntime,
    t: (key, params) => {
      const copy = (dictionary as Record<string, string>)[key] ?? key
      return copy.replace(/\{(\w+)\}/g, (_match: string, name: string) => {
        const value = params?.[name]
        return typeof value === 'string' || typeof value === 'number' ? String(value) : name
      })
    },
    selectTrialGroup: vi.fn(),
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
    render(<TrialDock {...(f.props as ComponentProps<typeof TrialDock>)} />)
    expect(screen.getByText(/800.000 tokens restantes/)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fazer upgrade' }))
    expect(f.props.showTrial).toHaveBeenCalledOnce()
  })
})
