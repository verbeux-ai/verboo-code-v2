// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { TrialId, TrialOfferId, TrialAttemptId } from '@deepseek-ai/dsh-api-verboo-product/types'
import { TrialModal, TrialDock } from '../src/client/Trial.tsx'
import type { TrialSnapshot } from '../src/client/trial-model.ts'
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
  const product = {
    profile: { id: 'owner' },
    plans: {
      catalog: [
        {
          id: 'max',
          slug: 'max',
          name: 'Max',
          description: 'More parallel projects',
          currency: 'USD',
          priceCents: 12900,
          interval: 'month',
        },
        {
          id: 'pro',
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
  const props = {
    useTrial: (select: (s: TrialSnapshot) => unknown) => select(state),
    useProduct: (select: (s: typeof product) => unknown) => select(product),
    usePreferences: (select: (s: { locale: string }) => unknown) => select({ locale }),
    t: (key: string, params: Record<string, string> = {}) =>
      (dictionary as Record<string, string>)[key]?.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? name) ??
      key,
    useStaminaModel: (select: (s: { current: null }) => unknown) => select({ current: null }),
    selectTrialGroup: vi.fn(),
    loadPlans: vi.fn(),
    showTrial: vi.fn(),
    closeTrial: vi.fn(),
    quoteTrial: vi.fn(),
    confirmTrial: vi.fn(),
    refreshTrial: vi.fn(),
    reopenTrial: vi.fn(),
  } as unknown as ComponentProps<typeof TrialModal>
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
