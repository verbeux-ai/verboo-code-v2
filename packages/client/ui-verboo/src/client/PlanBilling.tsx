import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BillingSubscriptionId, Plan, Subscription } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { BillingInjected, ProductProps } from './contracts.ts'
import type { BillingState } from './billing-model.ts'
import type { Key } from './locales.ts'
import { Glyph } from './Glyph.tsx'
import { Busy } from './PageParts.tsx'
import { billingMotionMs, useBillingPresence } from './billing-motion.ts'
import styles from './Plans.module.css'

type Actions = Omit<BillingInjected, 'hooks'>
interface PanelProps extends Actions {
  state: BillingState
  locale: string
  t: ProductProps['t']
}

const purchaseMessages = {
  pending: 'billingProcessing', requires_action: 'billingPaymentReady', succeeded: 'billingPaid',
  failed: 'billingPaymentFailed', expired: 'billingExpired', review: 'billingReview',
  unconfirmed: 'billingUnknown', reactivated: 'billingReactivated', abandoned: 'billingPurchaseAbandoned',
} as const satisfies Record<string, Key>

const changeMessages: Partial<Record<string, Key>> = {
  scheduled: 'billingChangeScheduled', completed: 'billingChangeComplete', failed: 'billingChangeFailed',
  canceled: 'canceled', cancelled: 'canceled', expired: 'billingExpired',
  requires_action: 'billingPaymentReady', reconciliation_required: 'billingReview',
  unconfirmed: 'billingUnknown',
}

const safeCardUpdateMessages = {
  pending: 'billingCardUpdatePending', confirmed: 'billingCardUpdated',
  failed: 'billingCardUpdateUnavailable', expired: 'billingCardUpdateExpired',
} as const satisfies Record<string, Key>

const endPurchase = new Set(['succeeded', 'failed', 'expired', 'reactivated', 'abandoned'])
const endChange = new Set(['completed', 'failed', 'canceled', 'cancelled', 'expired'])

function price(amount: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 100)
}

function day(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value))
}

/**
 * Label catalog options whose use is limited, including inside the plan chooser.
 * @param props - catalog item and translation function.
 * @returns a badge for Lite, or null for other plans.
 */
export function LimitedPlanBadge({ plan, t }: { plan: Plan; t: ProductProps['t'] }) {
  return (plan.slug || plan.name).trim().toLowerCase() === 'lite'
    ? <span className={styles.limited}>{t('planLimitedUsage')}</span> : null
}

function BillingNotice({ message, tone = 'neutral' }: { message: string; tone?: 'neutral' | 'positive' | 'attention' }) {
  return <p className={styles.billingNotice} role="status" data-tone={tone}>
    <Glyph name={tone === 'positive' ? 'circle-check' : tone === 'attention' ? 'circle-alert' : 'info'} size={17} />
    <span>{message}</span>
  </p>
}

/**
 * Inline card checkout and its server-confirmed progress.
 * @param props - current billing snapshot, plan, and account-bound actions.
 * @returns the selected offer or its original payment attempt.
 */
export function CheckoutPanel(props: PanelProps & { expanded: boolean; subscriptions: Subscription[]; catalog: Plan[] }) {
  const { state, t, locale } = props
  const purchase = state.purchase
  const offer = state.offer
  const [abandon, setAbandon] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (props.expanded) heading.current?.focus() }, [props.expanded])
  if (state.selectedPlan === null && purchase === null) return null
  const plan = purchase
    ? props.catalog.find(row => row.id === purchase.planId && row.interval === purchase.interval) ??
      (state.selectedPlan?.id === purchase.planId ? state.selectedPlan : null)
    : state.selectedPlan
  const paymentTone = purchase?.status === 'succeeded' || purchase?.status === 'reactivated' ? 'positive' :
    purchase?.declined || purchase?.status === 'failed' || purchase?.status === 'review' ? 'attention' : 'neutral'
  return <section className={`${styles.billingPanel} ${styles.checkout}`} aria-labelledby="verboo-checkout-title" aria-busy={state.busy}>
    <div className={styles.billingPanelHeader}>
      <span className={styles.planIcon}><Glyph name="credit-card" size={20} /></span>
      <h3 id="verboo-checkout-title" tabIndex={-1} ref={heading}>{t('billingCheckout')}{plan ? ' · ' + plan.name : ''}</h3>
    </div>
    {offer && <dl className={styles.checkoutFacts}>
      <div>
        <dt>{t('billingAmountNow')}</dt><dd>{price(offer.initialAmountMinor, offer.currency, locale)}</dd>
      </div>
      <div>
        <dt>{t('billingRenewal')}</dt>
        <dd>{price(offer.renewalAmountMinor, offer.currency, locale)}{' '}
          <span>{t(offer.interval === 'year' ? 'yearly' : 'monthly')}</span>
        </dd>
      </div>
      <div>
        <dt>{t('billingMethod')}</dt><dd>{t('billingCard')}</dd>
      </div>
    </dl>}
    {purchase && <BillingNotice tone={paymentTone} message={t(purchase.closedUnstarted ? 'billingCheckoutClosedUnstarted' :
      purchase.declined ? purchase.status === 'failed' ? 'billingCardDeclined' : 'billingTryAnotherCard' : purchaseMessages[purchase.status])} />}
    {state.recommendation && <div className={styles.billingChoices}>
      <p>{t('billingExistingSubscription')}</p>
      {state.recommendation.subscriptions.map((option) => {
        const subscription = props.subscriptions.find(row => row.id === option.subscriptionId)
        if (option.action === 'resume' && option.attemptId) {
          const id = option.attemptId
          return <Button key={option.subscriptionId} variant="primary" disabled={state.busy} onClick={() => { props.reopenPurchase(id) }}>{t('billingContinuePayment')}</Button>
        }
        if (!subscription) return null
        return <Button key={subscription.id} variant="outline" disabled={state.busy} onClick={() => {
          props.manageSubscription(subscription)
          if (option.action === 'change' && subscription.canUpgrade && state.selectedPlan) {
            props.previewPlanChange(option.subscriptionId, state.selectedPlan)
          }
        }}>{t(canManageSubscription(subscription) ? 'manage' : 'billingDetails')} · {subscription.name}</Button>
      })}
    </div>}
    {state.notice && <BillingNotice tone="attention" message={t(state.notice)} />}
    <div className={styles.billingActions}>
      {offer && <Button variant="primary" disabled={state.busy} onClick={props.confirmPurchase}>{t('billingConfirmCard')}</Button>}
      {purchase && ['pending', 'requires_action'].includes(purchase.status) &&
        <Button variant="primary" disabled={state.busy} onClick={() => { props.reopenPurchase(purchase.id) }}>
          {t('billingContinuePayment')}<Glyph name="arrow-up-right" size={14} />
        </Button>}
      {state.notice === 'billingTermsRequired' &&
        <Button variant="outline" disabled={state.busy} onClick={props.openBillingTerms}>{t('billingOpenTerms')}</Button>}
      {purchase?.canRetry &&
        <Button variant="outline" disabled={state.busy} onClick={() => { props.retryPurchase(purchase.id) }}>{t('billingRetryOriginal')}</Button>}
      {purchase && !endPurchase.has(purchase.status) &&
        <Button variant="outline" disabled={state.busy} onClick={props.refreshBilling}>{t('refresh')}</Button>}
      {purchase?.canAbandon && !abandon &&
        <Button variant="ghost" className={styles.secondaryAction} disabled={state.busy}
          onClick={() => { setAbandon(true) }}>{t('billingAbandon')}</Button>}
      {(!purchase || endPurchase.has(purchase.status)) &&
        <Button variant="ghost" disabled={state.busy} onClick={props.closePurchase}>{t('close')}</Button>}
    </div>
    {offer && <p className={styles.billingNote}><Glyph name="shield-check" size={15} />{t('billingNote')}</p>}
    {purchase?.canAbandon && abandon && <div className={styles.billingReview} data-tone="attention">
      <p>{t(purchase.status === 'unconfirmed' ? 'billingCloseUnstartedExplanation' : 'billingAbandonExplanation')}</p>
      <div className={styles.billingActions}>
        <Button variant="outline" className={styles.destructiveAction} disabled={state.busy} onClick={() => {
          setAbandon(false)
          props.abandonPurchase(purchase.id)
        }}>{t('billingAbandon')}</Button>
        <Button variant="ghost" onClick={() => { setAbandon(false) }}>{t('close')}</Button>
      </div>
    </div>}
  </section>
}

/**
 * Identify subscriptions with at least one server-authorized billing action.
 * @param subscription - selected subscription for the current account.
 * @returns whether the app can offer billing management.
 */
export function canManageSubscription(subscription: Subscription): boolean {
  const permissions = subscription.permissions
  return subscription.canUpgrade || permissions?.cancel === true || permissions?.reactivate === true ||
    permissions?.invoices === true || permissions?.cardUpdate === true
}

const actionTitles = {
  change: 'billingChangePlan', card: 'billingChangeCard', invoices: 'billingInvoices',
  cancel: 'billingCancelSubscription', reactivate: 'billingReactivate',
} as const satisfies Record<string, Key>

const actionIcons = {
  change: 'layers', card: 'credit-card', invoices: 'file-check-2',
  cancel: 'calendar-days', reactivate: 'rotate-cw',
} as const

type ManagementAction = keyof typeof actionTitles
type SubscriptionProps = PanelProps & { subscription: Subscription; statusLabel: string; catalog: Plan[] }

function CardResult({ state, t }: Pick<PanelProps, 'state' | 't'>) {
  const card = state.cardUpdate
  if (!card) return null
  return <BillingNotice
    tone={card.status === 'confirmed' ? 'positive' : card.status === 'pending' ? 'neutral' : 'attention'}
    message={t(card.status === 'pending' && state.cardAwaitingConfirmation ? 'billingProcessing' : safeCardUpdateMessages[card.status])} />
}

function ChangeResult({ state, locale, t }: Pick<PanelProps, 'state' | 'locale' | 't'>) {
  const change = state.change
  if (!change) return null
  return <BillingNotice
    tone={change.status === 'completed' ? 'positive' : change.status === 'failed' ? 'attention' : 'neutral'}
    message={t(changeMessages[change.status] ?? 'billingProcessing') +
      (change.effectiveAt ? ' · ' + day(change.effectiveAt, locale) : '')} />
}

function LifecycleResult({ state, subscription, locale, t }: Pick<SubscriptionProps, 'state' | 'subscription' | 'locale' | 't'>) {
  const progress = state.lifecycleProgress
  if (progress?.action === 'reactivate' && progress.status === 'confirmed') {
    return <BillingNotice tone="positive" message={t('billingReactivated')} />
  }
  if (progress && progress.status !== 'confirmed') {
    return <BillingNotice message={t(progress.status === 'reconciliation_required' ? 'billingReview' :
      progress.status === 'unconfirmed' ? 'billingUpdateUnconfirmed' : 'billingCancelPending')} />
  }
  const cancellation = state.cancellation ?? subscription.cancellation
  if (!cancellation) return null
  if (cancellation.localStatus === 'pending' || cancellation.collectionStatus !== 'stopped') {
    return <BillingNotice message={t('billingCancelPending')} />
  }
  const accessUntil = cancellation.accessUntil ?? subscription.renewsAt
  return <BillingNotice message={t('billingCancellationConfirmed') +
    (accessUntil ? ' · ' + t('billingAccessUntil', { date: day(accessUntil, locale) }) : '')} />
}

function ChangeForm(props: SubscriptionProps & { candidatePlans: Plan[]; canChoose: boolean; onBack(this: void): void }) {
  const { state, subscription, candidatePlans, canChoose, locale, t } = props
  const [removeTier, setRemoveTier] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const review = useRef<HTMLHeadingElement>(null)
  const offer = state.changeOffer
  const offerId = offer?.id
  useEffect(() => { if (offerId) review.current?.focus() }, [offerId])
  const target = offer && candidatePlans.find(plan => plan.id === offer.targetPlanId && plan.interval === offer.interval)
  const billingId = subscription.id as BillingSubscriptionId
  const choose = canChoose && !offer && (!submitted || state.notice !== null || state.change?.status === 'failed')
  const paymentUrl = state.change?.url
  if (offer && canChoose) return <>
    <h3 className={`${styles.modalReviewTitle} ${styles.cardName}`} ref={review} tabIndex={-1}>
      <span>{t('billingNewPlan')}{target ? ' · ' + target.name : ''}</span>
      {target && <LimitedPlanBadge plan={target} t={t} />}
    </h3>
    <dl className={styles.billingFacts}>
      <dt>{t('billingAmountNow')}</dt><dd>{price(offer.amountDueNowCents, offer.currency, locale)}</dd>
      {offer.creditNowCents > 0 && <>
        <dt>{t('billingCredit')}</dt><dd>{price(offer.creditNowCents, offer.currency, locale)}</dd>
      </>}
      <dt>{t('billingRenewal')}</dt><dd>{price(offer.nextRenewalAmountCents, offer.currency, locale)} · {day(offer.nextRenewalAt, locale)}</dd>
      <dt>{t('billingEffective')}</dt><dd>{day(offer.effectiveAt, locale)}</dd>
    </dl>
    {offer.undoesCancellation && <p>{t('billingChangeUndoCancel')}</p>}
    {offer.removesConcurrencyTier && <p>{t('billingChangeRemoveTier')}</p>}
    {offer.pixMandateAmountCents !== undefined && <p>{t('billingPixMandate', {
      amount: price(offer.pixMandateAmountCents, offer.currency, locale),
    })}</p>}
    <div className={styles.modalActions}>
      <Button variant="ghost" disabled={state.busy} onClick={props.onBack}>{t('billingChooseAnotherPlan')}</Button>
      <Button variant="primary" disabled={state.busy} onClick={() => { setSubmitted(true); props.confirmPlanChange() }}>
        {t('billingConfirmChange')}
      </Button>
    </div>
  </>
  if (choose) return <>
    {subscription.canRemoveTier && <label className={styles.tierChoice}>
      <input type="checkbox" checked={removeTier} onChange={(event) => { setRemoveTier(event.target.checked) }} />
      {t('billingRemoveTier')}
    </label>}
    {state.busy && <Busy label={t('loading')} />}
    <div className={styles.modalPlanList}>
      {candidatePlans.map(plan => <Button key={plan.id + plan.interval} variant="outline" disabled={state.busy}
        onClick={() => { props.previewPlanChange(billingId, plan, removeTier) }}>
        <span><strong>{plan.name}</strong> {t(plan.interval === 'year' ? 'yearly' : 'monthly')} <LimitedPlanBadge plan={plan} t={t} /></span>
        {plan.priceCents > 0 && <span>{price(plan.priceCents, plan.currency, locale)}</span>}
        <Glyph name="chevron-right" size={15} />
      </Button>)}
    </div>
  </>
  return <>
    {state.busy && <Busy label={t('loading')} />}
    <ChangeResult state={state} locale={locale} t={t} />
    {(paymentUrl || (state.change && !endChange.has(state.change.status))) && <div className={styles.modalActions}>
      <Button variant="outline" disabled={state.busy} onClick={props.refreshBilling}>{t('refresh')}</Button>
      {paymentUrl && <Button variant="primary" disabled={state.busy} onClick={() => { props.openBillingLink(paymentUrl) }}>
        {t('billingContinuePayment')}<Glyph name="arrow-up-right" size={15} />
      </Button>}
    </div>}
  </>
}

function InvoiceList(props: SubscriptionProps) {
  const { state, locale, t } = props
  const { invoices, notice, busy } = state
  if (invoices === null && !notice) return <Busy label={t('loading')} />
  return <>
    {notice && <Button variant="outline" disabled={busy}
      onClick={() => { props.loadBillingInvoices(props.subscription.id as BillingSubscriptionId) }}>
      {t('retry')}
    </Button>}
    {invoices?.length === 0 && <p>{t('billingNoInvoices')}</p>}
    {invoices && invoices.length > 0 && <ul className={styles.billingInvoices}>
      {invoices.map((invoice) => {
        const pay = invoice.status === 'open' ? invoice.url : null
        return <li key={invoice.id}>
          <span className={styles.invoiceIdentity}>
            {invoice.number && <strong>{invoice.number}</strong>}
            <time dateTime={invoice.created}>{day(invoice.created, locale)}</time>
          </span>
          <span className={styles.invoiceAmount}>
            {price(invoice.status === 'paid' ? invoice.amountPaid : invoice.amountDue, invoice.currency, locale)}
          </span>
          <span className={styles.status} data-tone={invoice.status === 'paid' ? 'positive' : invoice.status === 'open' ? 'attention' : 'neutral'}>
            <span aria-hidden="true" />
            {t(invoice.status === 'paid' ? 'billingInvoicePaid' : invoice.status === 'open' ? 'billingInvoiceOpen' : 'billingInvoiceOther')}
          </span>
          {pay && <Button variant="outline" disabled={busy} onClick={() => { props.openBillingLink(pay) }}>
            {t('billingPayInvoice')}<Glyph name="arrow-up-right" size={14} />
          </Button>}
        </li>
      })}
    </ul>}
  </>
}

function SubscriptionActionDialog(props: SubscriptionProps & {
  action: ManagementAction
  open: boolean
  candidatePlans: Plan[]
  canChoosePlan: boolean
  accessUntil: string | null
  close(this: void): void
  onBack(this: void): void
}) {
  const { action, state, subscription, accessUntil, t, locale } = props
  const id = subscription.id as BillingSubscriptionId
  const [cardStarted, setCardStarted] = useState(false)
  const title = t(actionTitles[action])
  const nativeCard = action === 'card' && globalThis.__VERBOO_DESKTOP__?.openCardSetup !== undefined
  const startCard = () => {
    setCardStarted(true)
    if (nativeCard) props.updateBillingCard(id, {
      title, description: t('billingNativeCardIntro'), close: t('close'), loading: t('loading'), failed: t('billingCardUpdateUnavailable'),
    })
    else props.updateBillingCard(id)
  }
  const autoOpened = useRef(false)
  useEffect(() => {
    if (props.open && nativeCard && !autoOpened.current) {
      autoOpened.current = true
      startCard()
    }
  }, [props.open, nativeCard])
  const cardConfirmed = cardStarted && state.cardUpdate?.status === 'confirmed' && !state.busy && !state.notice
  const isLifecycle = action === 'cancel' || action === 'reactivate'
  return <Modal headless backdropBlur={false} open={props.open} title={title} onClose={props.close}
    motion={{ durationMs: billingMotionMs, closing: !props.open }} className={styles.managementModal ?? ''}>
    <header className={styles.modalHeader}>
      <span className={styles.planIcon}><Glyph name={actionIcons[action]} size={20} /></span>
      <div>
        <h2>{title}</h2>
        <p>{subscription.name}</p>
      </div>
      <Button variant="ghost" className={styles.modalClose} aria-label={t('close')} disabled={state.busy} onClick={props.close}>
        <Glyph name="x" size={18} />
      </Button>
    </header>
    <div className={styles.modalBody} aria-busy={state.busy}>
      {state.notice && <BillingNotice tone="attention" message={t(state.notice)} />}
      {action === 'change' && <ChangeForm {...props} canChoose={props.canChoosePlan} />}
      {action === 'card' && <>
        {nativeCard && !cardConfirmed && !state.cardAwaitingConfirmation && <p>{t('billingNativeCardIntro')}</p>}
        {!nativeCard && state.cardUpdate?.status !== 'pending' && !cardConfirmed && <p>{t('billingCardSetupIntro')}</p>}
        {state.busy && <Busy label={t('loading')} />}
        {(cardConfirmed || state.cardUpdate?.status !== 'confirmed') &&
          (!nativeCard || state.cardUpdate?.status !== 'pending' || state.cardAwaitingConfirmation) &&
          <CardResult state={state} t={t} />}
        <div className={styles.modalActions}>
          {state.cardUpdate?.status === 'pending' &&
            <Button variant="outline" disabled={state.busy}
              onClick={nativeCard && state.cardAwaitingConfirmation ? startCard : props.refreshBilling}>{t('refresh')}</Button>}
          {cardConfirmed
            ? <Button variant="primary" disabled={state.busy} onClick={props.close}>{t('close')}</Button>
            : !state.cardAwaitingConfirmation && <Button variant="primary" disabled={state.busy} onClick={startCard}>
              {t(nativeCard ? state.cardUpdate?.status === 'pending' ? 'billingContinueCardUpdate' : 'billingChangeCard' : 'billingOpenStripe')}
              {!nativeCard && <Glyph name="arrow-up-right" size={15} />}
            </Button>}
        </div>
      </>}
      {action === 'invoices' && <InvoiceList {...props} />}
      {isLifecycle && (state.lifecycle === action ? <>
        <p>{t(action === 'cancel' ? 'billingCancelExplanation' : 'billingReactivateExplanation')}</p>
        {action === 'cancel' && accessUntil && <p className={styles.modalDate}>
          <Glyph name="calendar-days" size={17} />{t('billingAccessUntil', { date: day(accessUntil, locale) })}
        </p>}
        {action === 'reactivate' && subscription.billing && <dl className={styles.billingFacts}>
          <dt>{t('billingCurrentPrice')}</dt>
          <dd>{price(subscription.billing.amountMinor, subscription.billing.currency, locale)} {t(subscription.billing.interval === 'year' ? 'yearly' : 'monthly')}</dd>
          {subscription.renewsAt && <><dt>{t('billingRenewal')}</dt><dd>{day(subscription.renewsAt, locale)}</dd></>}
        </dl>}
        <div className={styles.modalActions}>
          <Button variant="ghost" disabled={state.busy} onClick={props.close}>{t('close')}</Button>
          <Button variant={action === 'cancel' ? 'outline' : 'primary'}
            className={action === 'cancel' ? styles.destructiveAction : undefined}
            disabled={state.busy} onClick={() => { props.updateSubscription(id) }}>
            {t(action === 'cancel' ? 'billingConfirmCancel' : 'billingReactivate')}
          </Button>
        </div>
      </> : <>
        {state.busy && <Busy label={t('loading')} />}
        {state.lifecycleProgress?.action === action && <LifecycleResult {...props} />}
        <div className={styles.modalActions}>
          {state.lifecycleProgress?.action === action && state.lifecycleProgress.status !== 'confirmed'
            ? <Button variant="outline" disabled={state.busy} onClick={props.refreshBilling}>{t('refresh')}</Button>
            : <Button variant="outline" disabled={state.busy} onClick={props.close}>{t('close')}</Button>}
        </div>
      </>)}
      {state.notice === 'billingTermsRequired' && <div className={styles.modalActions}>
        <Button variant="outline" disabled={state.busy} onClick={props.openBillingTerms}>{t('billingOpenTerms')}</Button>
      </div>}
    </div>
  </Modal>
}

/**
 * Show authorized actions for one subscription and keep each operation in its own dialog.
 * @param props - selected subscription, current billing state, and account-bound actions.
 * @returns the selected subscription panel and its active dialog.
 */
export function SubscriptionPanel(props: SubscriptionProps & { expanded: boolean }) {
  const { subscription, state, locale, t, expanded } = props
  const id = subscription.id as BillingSubscriptionId
  const allowed = subscription.permissions
  const heading = useRef<HTMLHeadingElement>(null)
  const [selectedAction, setAction] = useState<ManagementAction | null>(null)
  const wasExpanded = useRef(false)
  useEffect(() => {
    if (expanded && !wasExpanded.current && !state.reviewingChange && state.changeOffer === null && state.lifecycle === null) {
      heading.current?.focus()
    }
    wasExpanded.current = expanded
  }, [expanded, state.reviewingChange, state.changeOffer, state.lifecycle])
  useLayoutEffect(() => { if (!expanded) setAction(null) }, [expanded])
  const candidatePlans = props.catalog.filter(plan =>
    plan.id !== subscription.planId || plan.interval !== subscription.billing?.interval)
  const action = selectedAction ?? (state.reviewingChange || state.changeOffer !== null ? 'change' : state.lifecycle)
  const dialogOpen = expanded && action !== null
  const dialogVersion = useRef(0)
  useLayoutEffect(() => { if (!dialogOpen) dialogVersion.current++ }, [dialogOpen])
  const dialog = useBillingPresence(dialogOpen ? { action, state, version: dialogVersion.current } : null)
  const progress = state.lifecycleProgress
  const renewalRestored = progress?.action === 'reactivate' && progress.status === 'confirmed'
  const cancellation = renewalRestored ? null : state.cancellation ?? subscription.cancellation
  const accessUntil = cancellation?.accessUntil ?? subscription.renewsAt
  const accessEnds = cancellation?.accessUntil != null || subscription.cancelAtEnd ||
    subscription.status === 'canceled' || subscription.status === 'incomplete_expired'
  const periodKey: Key = accessEnds ? 'ends' : subscription.billing === null ? 'billingPeriodEnd' : 'renews'
  const pendingCancellation = cancellation?.localStatus === 'pending' || (cancellation != null && cancellation.collectionStatus !== 'stopped')
  const changePending = state.change !== null && !endChange.has(state.change.status)
  const lifecyclePending = progress != null && progress.status !== 'confirmed'
  const canChoosePlan = subscription.canUpgrade && candidatePlans.length > 0 && !changePending && !lifecyclePending
  const canOpenChange = canChoosePlan || changePending
  const canCancel = allowed?.cancel && !pendingCancellation && !lifecyclePending
  const canReactivate = allowed?.reactivate && !pendingCancellation && !lifecyclePending
  const canUpdateCard = allowed?.cardUpdate && !lifecyclePending && !pendingCancellation
  const showsActions = canOpenChange || canCancel || canReactivate || canUpdateCard || allowed?.invoices
  const openAction = (next: ManagementAction) => {
    if (state.busy) return
    setAction(next)
    props.reviewSubscriptionAction(next === 'cancel' || next === 'reactivate' ? next : null)
    if (next === 'invoices') props.loadBillingInvoices(id)
  }
  const closeAction = () => {
    if (state.busy) return
    if (selectedAction === null && state.reviewingChange) {
      requestAnimationFrame(() => { heading.current?.focus() })
    }
    props.reviewSubscriptionAction(null)
    setAction(null)
  }
  return <section className={styles.billingPanel} aria-label={subscription.name} aria-busy={state.busy}>
    <div className={styles.billingPanelHeader}>
      <h3 tabIndex={-1} ref={heading}>{subscription.name}</h3>
    </div>
    {!showsActions && <>
      <dl className={styles.billingFacts}>
        <dt>{t('status')}</dt><dd>{props.statusLabel}</dd>
        {accessUntil && <><dt>{t(periodKey)}</dt><dd>{day(accessUntil, locale)}</dd></>}
        {subscription.billing && <>
          <dt>{t('billingCurrentPrice')}</dt>
          <dd>{price(subscription.billing.amountMinor, subscription.billing.currency, locale)} {t(subscription.billing.interval === 'year' ? 'yearly' : 'monthly')}</dd>
        </>}
      </dl>
      {!pendingCancellation && !lifecyclePending && state.change === null && <p>{t('billingNoActions')}</p>}
    </>}
    {action === null && <>
      <LifecycleResult {...props} />
      <ChangeResult state={state} locale={locale} t={t} />
      <CardResult state={state} t={t} />
      {(pendingCancellation || lifecyclePending) && <div className={styles.billingActions}>
        <Button variant="outline" disabled={state.busy} onClick={props.refreshBilling}>{t('refresh')}</Button>
      </div>}
    </>}
    {showsActions && <div className={styles.billingActions}>
      {canOpenChange && <Button variant={canReactivate ? 'outline' : 'primary'} aria-haspopup="dialog" disabled={state.busy}
        onClick={() => { openAction('change') }}>{t(changePending ? 'billingTrackChange' : 'billingChangePlan')}</Button>}
      {canReactivate && <Button variant="primary" aria-haspopup="dialog" disabled={state.busy}
        onClick={() => { openAction('reactivate') }}>{t('billingReactivate')}</Button>}
      {canUpdateCard && <Button variant="outline" aria-haspopup="dialog" disabled={state.busy}
        onClick={() => { openAction('card') }}>{t(state.cardUpdate?.status === 'pending' ? 'billingContinueCardUpdate' : 'billingChangeCard')}</Button>}
      {allowed?.invoices && <Button variant="outline" aria-haspopup="dialog" disabled={state.busy}
        onClick={() => { openAction('invoices') }}>{t('billingInvoices')}</Button>}
      {canCancel && <Button variant="ghost" className={`${styles.secondaryAction} ${styles.cancelAction}`} aria-haspopup="dialog" disabled={state.busy}
        onClick={() => { openAction('cancel') }}>{t('billingCancelSubscription')}</Button>}
    </div>}
    {expanded && dialog !== null && <SubscriptionActionDialog key={`${dialog.action}:${dialog.version}`} {...props}
      action={dialog.action} state={dialog.state} open={dialogOpen} candidatePlans={candidatePlans}
      accessUntil={accessUntil} canChoosePlan={canChoosePlan} close={closeAction}
      onBack={() => { setAction('change'); props.reviewSubscriptionAction(null) }} />}
  </section>
}
