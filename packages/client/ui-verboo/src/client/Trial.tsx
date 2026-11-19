/** Trial offers live beside the composer and in one dismissible, accessible app modal. */
import { useEffect } from 'react'
import { Modal, Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HostObservable,
  InjectFace,
  PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { PlanId } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ProductProps } from './contracts.ts'
import type { TrialSnapshot } from './trial-model.ts'
import { Glyph } from './Glyph.tsx'
import {
  selectStaminaForModel,
  type StaminaModelProps,
} from './stamina-selection.ts'
import css from './Trial.module.css'

export interface TrialInjected {
  hooks: { trial: HostObservable<TrialSnapshot> }
  selectTrialGroup(this: void, group: PlanId | null): void
  showTrial(this: void): void
  closeTrial(this: void): void
  quoteTrial(this: void, plan: PlanId, method?: 'card' | 'pix'): void
  confirmTrial(this: void, method: 'card' | 'pix'): void
  refreshTrial(this: void): void
  reopenTrial(this: void): void
}
type TrialProps = ProductProps & InjectFace<TrialInjected>

/** Quiet, actionable balance notice without a blocking modal while the trial is still valid. */
export function TrialDock(
  props: PropsRuntime<'conversation.composer.dock'> &
    TrialProps &
    StaminaModelProps,
) {
  const state = props.useTrial(s => s)
  const locale = props.usePreferences(s => s.locale)
  const plans = props.useProduct(s => s.plans)
  const model = props.useStaminaModel(s => s.current)
  const selected = selectStaminaForModel(plans, model, undefined)
  const groupId = selected.group?.id
  const notice = groupId
    ? state.paidGroupIds?.includes(groupId)
      ? undefined
      : (state.allNotices ?? state.notices).find(
        item => item.groupId === groupId,
      )
    : state.notices[0]
  if (!notice) return null
  return (
    <aside className={css.dock} data-verboo-trial-notice>
      <Glyph name="sparkles" size={14} />
      <span>
        {props.t(notice.state === 'ended' ? 'trialEnded' : 'trialEnding')}
        {notice.tokensRemaining !== undefined && (
          <>
            {' '}
            ·{' '}
            {props.t('trialTokens', {
              count: new Intl.NumberFormat(locale).format(
                notice.tokensRemaining,
              ),
            })}
          </>
        )}
      </span>
      <button
        onClick={() => {
          props.selectTrialGroup(groupId ?? null)
          props.showTrial()
        }}
      >
        {props.t('trialUpgrade')}
        <Glyph name="arrow-up-right" size={13} />
      </button>
      {state.stale && (
        <button onClick={props.refreshTrial} aria-label={props.t('trialStale')}>
          <Glyph name="rotate-cw" size={13} />
        </button>
      )}
    </aside>
  )
}

/** Present the supported subscription plans without treating a quote as authorization. */
export function TrialModal(props: TrialProps) {
  const state = props.useTrial(s => s)
  const offer = state.offer
  const product = props.useProduct(s => s)
  const locale = props.usePreferences(s => s.locale)
  const visible = state.open && product.profile !== null
  const planOrder = ['pro', 'max', 'ultra']
  const planKey = (plan: { slug?: string; name: string }) => (plan.slug ?? plan.name).toLowerCase()
  const plans =
    product.plans?.catalog.filter(
      plan => plan.currency.toUpperCase() === 'USD' && planOrder.includes(planKey(plan)),
    ) ?? []
  const recommended =
    plans.find(plan => plan.slug === 'pro') ??
    plans.find(plan => plan.name.toLowerCase() === 'pro') ??
    plans[0]
  const sorted = [...plans].sort((a, b) =>
    planOrder.indexOf(planKey(a)) - planOrder.indexOf(planKey(b)),
  )
  const money = (amount: number, currency: string) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
    }).format(amount / 100)
  const ended = state.notices.some(notice => notice.state === 'ended')
  const pending =
    state.payment !== null && state.payment.status !== 'completed'
  useEffect(() => {
    if (!visible) return
    props.loadPlans()
  }, [visible, props.loadPlans])
  useEffect(() => {
    if (
      visible &&
      recommended &&
      !offer &&
      !state.quoting &&
      state.error === null &&
      !pending
    )
      props.quoteTrial(recommended.id)
  }, [
    visible,
    recommended?.id,
    offer,
    state.quoting,
    state.error,
    pending,
    props.quoteTrial,
  ])
  if (!visible) return null
  return (
    <Modal
      headless
      open={visible}
      onClose={props.closeTrial}
      title={props.t('trialHeadline')}
      className={css.modal as string}
    >
      <Button
        variant="ghost"
        className={css.close}
        onClick={props.closeTrial}
        aria-label={props.t('close')}
      >
        <Glyph name="x" size={18} />
      </Button>
      <header className={css.header}>
        <div className={css.headerCopy}>
          <div className={css.eyebrow}>{props.t(ended ? 'trialEnded' : 'trialEnding')}</div>
          <h1 id="verboo-trial-title">{props.t('trialHeadline')}</h1>
          <p id="verboo-trial-description">{props.t('trialDescription')}</p>
          {state.notices[0]?.tokensRemaining !== undefined && (
            <span className={css.balance}>
              {props.t('trialTokens', {
                count: new Intl.NumberFormat(locale).format(
                  state.notices[0].tokensRemaining,
                ),
              })}
            </span>
          )}
        </div>
      </header>
      <div className={css.plans} aria-label={props.t('plansTitle')}>
        {sorted.map(plan => (
          <button
            key={plan.id}
            className={css.plan}
            data-featured={plan.id === recommended?.id || undefined}
            data-selected={plan.id === offer?.planId || undefined}
            disabled={state.paying || pending}
            onClick={() => {
              props.quoteTrial(plan.id)
            }}
            aria-pressed={plan.id === offer?.planId}
          >
            <div className={css.planHeading}>
              <div className={css.planName}>
                <strong>{plan.name}</strong>
              </div>
              <span className={css.planIndicator} aria-hidden="true">{plan.id === offer?.planId && <Glyph name="check" size={12} />}</span>
            </div>
            <div className={css.price}>
              {money(plan.priceCents, plan.currency)}
              <small>
                {' '}
                {props.t(plan.interval === 'year' ? 'yearly' : 'monthly')}
              </small>
            </div>
            <span className={css.planStamina}>
              <span>{props.t('trialStaminaLevel', { level: planOrder.indexOf(planKey(plan)) + 1 })}</span>
              <span className={css.planLevels} aria-hidden="true">
                {[0, 1, 2].map(level => (
                  <span key={level} data-active={level <= planOrder.indexOf(planKey(plan)) || undefined} />
                ))}
              </span>
            </span>
          </button>
        ))}
      </div>
      {plans.length === 0 && (
        <p role="status">
          {props.t('trialCatalogUnavailable')}{' '}
          <button className={css.textButton} onClick={props.loadPlans}>
            {props.t('retry')}
          </button>
        </p>
      )}
      <section className={css.confirmation} aria-live="polite">
        {state.quoting && <p role="status">{props.t('trialQuoting')}</p>}
        {offer && !pending && (
          <>
            <div className={css.paymentGrid}>
              <div className={css.paymentMethod}>
                <h2>{props.t('trialPaymentMethod')}</h2>
                <select
                  aria-label={props.t('trialPaymentMethod')}
                  className={css.methodSelect}
                  value={offer.paymentMethod}
                  disabled={state.paying || state.stale || state.quoting}
                  onChange={(event) => {
                    const method = event.currentTarget.value
                    if (method === 'card' || method === 'pix') props.quoteTrial(offer.planId, method)
                  }}
                >
                  <option value="card">{offer.card ? `${offer.card.brand} ···· ${offer.card.last4}` : props.t('trialUseCard')}</option>
                  {(offer.pixAvailable || offer.paymentMethod === 'pix') && <option value="pix">{props.t('trialPayPix')}</option>}
                </select>
                <p>{props.t('trialImmediate')}</p>
                {!offer.pixAvailable && offer.paymentMethod !== 'pix' && <p>{props.t('trialPixUnavailable')}</p>}
                {offer.paymentMethod === 'pix' && offer.pixMandateAmountMinor && (
                  <p>{props.t('trialPixMandate', { price: money(offer.pixMandateAmountMinor, 'BRL') })}</p>
                )}
              </div>
              <div className={css.summary}>
                <h2>{props.t('trialOrderSummary')}</h2>
                <div className={css.summaryRow}>
                  <span>{offer.name}</span>
                  <span>{money(offer.renewalAmountMinor, offer.currency)} {props.t(offer.interval === 'year' ? 'yearly' : 'monthly')}</span>
                </div>
                <div className={css.total}>
                  <strong>{props.t('trialTotalDue')}</strong>
                  <strong>{money(offer.amountMinor, offer.currency)}</strong>
                </div>
              </div>
            </div>
            <div className={css.actions}>
              <Button
                variant="primary"
                className={css.primary}
                disabled={state.paying || state.error === 'unconfirmed' || state.stale || state.quoting || Date.parse(offer.expiresAt) <= Date.now()}
                onClick={() => { props.confirmTrial(offer.paymentMethod) }}
              >
                {state.paying
                  ? props.t('trialProcessing')
                  : props.t(offer.paymentMethod === 'pix' || offer.card ? 'trialSubscribe' : 'trialContinueCard', {
                    price: money(offer.amountMinor, offer.currency),
                  })}
              </Button>
            </div>
          </>
        )}
        {pending && (
          <div className={css.pending} role="status">
            <Glyph name="clock-3" size={20} />
            <p>
              {props.t(
                state.payment?.status === 'setup_required'
                  ? 'trialSetupPending'
                  : 'trialPaymentPending',
              )}
            </p>
            <div className={css.actions}>
              {(state.payment?.url || state.payment?.attemptId) && (
                <Button
                  variant="outline"
                  className={css.secondary}
                  onClick={props.reopenTrial}
                >
                  {props.t('trialReopenPayment')}
                </Button>
              )}
              <button className={css.textButton} onClick={props.refreshTrial}>
                {props.t('trialCheckPayment')}
              </button>
            </div>
          </div>
        )}
        {state.stale && (
          <p role="status">
            {props.t('trialStale')}{' '}
            <button className={css.textButton} onClick={props.refreshTrial}>
              {props.t('retry')}
            </button>
          </p>
        )}
        {state.error && (
          <p role="alert">
            {props.t(
              state.error === 'quote'
                ? 'trialQuoteFailed'
                : state.error === 'navigation'
                  ? 'trialNavigationFailed'
                  : state.error === 'payment'
                    ? 'trialPaymentFailed'
                    : 'trialPaymentUnconfirmed',
            )}{' '}
            <button
              className={css.textButton}
              onClick={
                (state.error === 'quote' || state.error === 'payment') &&
                recommended
                  ? () => {
                    props.quoteTrial(recommended.id)
                  }
                  : props.refreshTrial
              }
            >
              {props.t('retry')}
            </button>
          </p>
        )}
      </section>
      <footer className={css.footer}>
        <Glyph name="shield-check" size={14} />
        {props.t('trialSecure')}
        <button className={css.textButton} onClick={props.closeTrial}>
          {props.t('trialLater')}
        </button>
      </footer>
    </Modal>
  )
}
