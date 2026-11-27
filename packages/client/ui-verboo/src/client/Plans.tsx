import { useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Plan, Subscription } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { BillingInjected, PageProps, ProductProps } from './contracts.ts'
import type { BillingState } from './billing-model.ts'
import { billingMotionMs, useBillingPresence } from './billing-motion.ts'
import type { Key } from './locales.ts'
import { Glyph } from './Glyph.tsx'
import { Busy, Notice, ReadFailure } from './PageParts.tsx'
import css from './Product.module.css'
import plansCss from './Plans.module.css'
import { CheckoutPanel, LimitedPlanBadge, SubscriptionPanel, canManageSubscription } from './PlanBilling.tsx'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'

type PlanActions = Pick<ProductProps, 't'>
type PlanPageProps = Pick<PageProps, 'useProduct' | 'usePreferences' | 't' | 'loadPlans' | 'billing' | 'start'>
  & InjectFace<BillingInjected>
const money = (amount: number, currency: string, locale: string) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 100)
const currentStatuses = ['active', 'trialing', 'past_due', 'incomplete', 'paused']
const historical = (subscription: Subscription) =>
  subscription.status === 'canceled' || subscription.status === 'incomplete_expired'
const subscriptionKey = (status: string): Key =>
  status === 'incomplete_expired' ? 'planExpired' :
    [...currentStatuses, 'unpaid', 'canceled'].includes(status) ? status as Key : 'planUnknown'

function SubscriptionRow({ subscription, locale, t, manage, expanded, panelId }: PlanActions & {
  subscription: Subscription
  manage(this: void): void
  locale: string
  expanded: boolean
  panelId: string
}) {
  const needsAttention = ['past_due', 'unpaid', 'incomplete', 'incomplete_expired'].includes(subscription.status)
  const canManage = canManageSubscription(subscription)
  const cancellation = subscription.cancellation
  const accessUntil = cancellation?.collectionStatus === 'stopped' && cancellation.localStatus === 'complete'
    ? cancellation.accessUntil : null
  const endsAt = accessUntil ?? subscription.renewsAt
  const period = subscription.cancelAtEnd || historical(subscription) || accessUntil
    ? 'ends' : subscription.billing === null ? 'billingPeriodEnd' : 'renews'
  return <article className={plansCss.subscription} data-subscription-status={subscription.status}>
    <div className={plansCss.subscriptionIdentity}>
      <span className={plansCss.planIcon}><Glyph name={subscription.billing ? 'credit-card' : 'layers'} size={20} /></span>
      <div>
        <h3>{subscription.name}</h3>
        <span className={plansCss.status} data-tone={needsAttention ? 'attention' : subscription.status === 'active' ? 'positive' : 'neutral'}>
          <span aria-hidden="true" />{t(subscriptionKey(subscription.status))}
        </span>
      </div>
    </div>
    {(subscription.billing || endsAt) && <dl className={plansCss.subscriptionFacts}>
      {subscription.billing && <div>
        <dt>{t('billingCurrentPrice')}</dt>
        <dd>{money(subscription.billing.amountMinor, subscription.billing.currency, locale)}{' '}
          <span>{t(subscription.billing.interval === 'year' ? 'yearly' : 'monthly')}</span>
        </dd>
      </div>}
      {endsAt && <div>
        <dt>{t(period)}</dt>
        <dd><time dateTime={endsAt}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(endsAt))}</time></dd>
      </div>}
    </dl>}
    <Button variant="outline" className={plansCss.subscriptionAction}
      aria-expanded={expanded} aria-controls={panelId}
      onClick={(event) => {
        if (expanded) event.currentTarget.focus()
        manage()
      }}
      aria-label={t(canManage ? 'managePlan' : 'billingDetailsNamed', { name: subscription.name })}>
      {t(canManage ? 'manage' : 'billingDetails')}
      <Glyph name="chevron-down" size={14} />
    </Button>
  </article>
}

type BillingPanels = Omit<BillingInjected, 'hooks'> & PlanActions & { state: BillingState; locale: string }

function SubscriptionEntry({ subscription, catalog, ...panel }: BillingPanels & {
  subscription: Subscription
  catalog: Plan[]
}) {
  const panelId = useId()
  const { state, locale, t, manageSubscription } = panel
  const expanded = subscription.id === state.selectedSubscription
  const visibleState = useBillingPresence(expanded ? state : null)
  return <div className={plansCss.subscriptionEntry} data-expanded={expanded}>
    <SubscriptionRow subscription={subscription} locale={locale} t={t} expanded={expanded}
      panelId={panelId} manage={() => { manageSubscription(expanded ? null : subscription) }} />
    <div id={panelId} className={plansCss.panelMotion} data-open={expanded}
      {...{ inert: expanded ? undefined : '' }} aria-hidden={!expanded || undefined}>
      <div>
        {visibleState !== null && <SubscriptionPanel {...panel} state={visibleState} subscription={subscription}
          expanded={expanded} statusLabel={t(subscriptionKey(subscription.status))} catalog={catalog} />}
      </div>
    </div>
  </div>
}

function PlanCard({ plan, current, locale, t, choose, busy, hasSubscription }: PlanActions & {
  plan: Plan
  current: boolean
  busy: boolean
  hasSubscription: boolean
  choose(this: void, plan: Plan, trigger: HTMLButtonElement): void
  locale: string
}) {
  return <article className={plansCss.card} data-plan-id={plan.id} data-current={current}>
    <div className={plansCss.cardName}>
      <h3>{plan.name}</h3>
      <LimitedPlanBadge plan={plan} t={t} />
    </div>
    <p className={plansCss.price}>
      <strong>{money(plan.priceCents, plan.currency, locale)}</strong>
      <span>{t(plan.interval === 'year' ? 'yearly' : 'monthly')}</span>
    </p>
    {plan.description && <p className={plansCss.description}>{plan.description}</p>}
    <div className={plansCss.cardFoot}>
      <Button variant={current || hasSubscription ? 'outline' : 'primary'} className={plansCss.choose}
        disabled={current || busy} onClick={(event) => { choose(plan, event.currentTarget) }}
        aria-label={current ? t('currentPlanNamed', { name: plan.name }) : t('choosePlanNamed', { name: plan.name })}>
        {current && <Glyph name="check" size={14} />}
        {t(current ? 'currentPlan' : 'buyPlan')}
        {!current && <Glyph name="arrow-right" size={14} />}
      </Button>
    </div>
  </article>
}

/**
 * Compare plans, purchase with card, and manage each subscription under its own summary.
 * @param props - account, presentation preferences, and account-scoped billing actions.
 * @returns the Plans and subscription page.
 */
export function PlanPage(props: PlanPageProps) {
  const plans = props.useProduct(s => s.plans)
  const failed = props.useProduct(s => s.plansFailed)
  const failureReason = props.useProduct(s => s.plansFailureReason)
  const loading = props.useProduct(s => s.loadingPlans)
  const handoff = props.useProduct(s => s.handoff)
  const locale = props.usePreferences(s => s.locale)
  const billing = props.useBillingPanel(s => s)
  const [selectedInterval, setSelectedInterval] = useState('month')
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyId = useId()
  const purchaseTrigger = useRef<HTMLButtonElement | null>(null)
  const checkoutOpen = billing.selectedPlan !== null || billing.purchase !== null
  const checkout = useBillingPresence(checkoutOpen ? billing : null)
  const intervals = [...new Set(plans?.catalog.map(plan => plan.interval))]
  const interval = intervals.includes(selectedInterval) ? selectedInterval : intervals[0]
  const catalog = plans?.catalog.filter(plan => plan.interval === interval) ?? []
  const currencyOrder = [...new Set(catalog.map(plan => plan.currency.toUpperCase()))]
  const priced = catalog.filter(plan => plan.priceCents > 0).sort((a, b) =>
    currencyOrder.indexOf(a.currency.toUpperCase()) - currencyOrder.indexOf(b.currency.toUpperCase()) || a.priceCents - b.priceCents,
  )
  const unpriced = catalog.filter(plan => plan.priceCents === 0)
  const owned = plans?.subscriptions.filter(subscription => !historical(subscription)) ?? []
  const history = plans?.subscriptions.filter(historical) ?? []
  const activeCatalog = plans?.catalog ?? []
  const choose = (plan: Plan, trigger: HTMLButtonElement) => {
    purchaseTrigger.current = trigger
    props.choosePurchase(plan)
  }
  const closePurchase = () => {
    props.closePurchase()
    requestAnimationFrame(() => { purchaseTrigger.current?.focus() })
  }
  const panel = { ...props, closePurchase, state: billing, locale }
  const renderSubscription = (subscription: Subscription) =>
    <SubscriptionEntry key={subscription.id} {...panel} subscription={subscription} catalog={activeCatalog} />
  const current = (plan: Plan) => owned.some(s => s.planId === plan.id &&
    (s.billing === null || s.billing.interval === plan.interval) && currentStatuses.includes(s.status))

  return <main className={`${css.page} ${plansCss.page}`} data-verboo-page="plan"
    style={{ '--billing-motion-duration': `${billingMotionMs}ms` } as CSSProperties}>
    <header className={plansCss.header}>
      <h1>{props.t('plansTitle')}</h1>
      <Button variant="outline" className={plansCss.refresh} disabled={loading} title={props.t('refresh')}
        aria-label={props.t('refresh')} onClick={props.loadPlans}>
        <Glyph name="rotate-cw" size={16} className={loading ? css.spin : undefined} />
      </Button>
    </header>
    {failed && <ReadFailure kind="plans" reason={failureReason} hasPrevious={plans !== null} retry={props.loadPlans} signIn={props.start} t={props.t} />}
    {handoff === 'billing' && <Notice text={props.t('purchasePending')} retry={props.loadPlans} label={props.t('refresh')} />}
    {plans === null ? loading && <Busy label={props.t('loading')} /> : <>
      <section className={plansCss.owned} aria-labelledby="verboo-subscriptions-heading">
        <h2 id="verboo-subscriptions-heading">{props.t('yourSubscriptions')}</h2>
        {owned.length === 0 && <div className={plansCss.noPlan}>
          <span className={plansCss.planIcon}><Glyph name="credit-card" size={20} /></span>
          <div><h3>{props.t('noPlan')}</h3><p>{props.t('noPlanDescription')}</p></div>
        </div>}
        {owned.map(renderSubscription)}
      </section>
      <section className={plansCss.catalog} aria-labelledby="verboo-plans-heading">
        <div className={plansCss.catalogHead}>
          <h2 id="verboo-plans-heading">{props.t('availablePlans')}</h2>
          {intervals.length > 1 && <SegmentedControl id="verboo-billing" value={interval ?? 'month'}
            label={props.t('billingInterval')} className={plansCss.interval}
            options={intervals.map(value => ({ value, label: props.t(value === 'year' ? 'annualBilling' : 'monthlyBilling') }))}
            onChange={setSelectedInterval} />}
        </div>
        <div className={plansCss.panelMotion} data-open={checkoutOpen}
          {...{ inert: checkoutOpen ? undefined : '' }} aria-hidden={!checkoutOpen || undefined}>
          <div>
            {checkout !== null && <CheckoutPanel key={checkout.purchase?.id ?? checkout.selectedPlan?.id ?? 'checkout'}
              {...panel} state={checkout} expanded={checkoutOpen} subscriptions={plans.subscriptions} catalog={activeCatalog} />}
          </div>
        </div>
        <div id={`verboo-billing-${interval}-panel`} role={intervals.length > 1 ? 'tabpanel' : undefined}
          aria-labelledby={intervals.length > 1 ? `verboo-billing-${interval}` : undefined}>
          {priced.length > 0 && <div className={plansCss.grid}>
            {priced.map(plan => <PlanCard key={plan.id} plan={plan} current={current(plan)}
              locale={locale} t={props.t} busy={billing.busy || billing.purchase !== null}
              hasSubscription={owned.length > 0} choose={choose} />)}
          </div>}
          {unpriced.length > 0 && <div className={plansCss.otherPlans}>
            {unpriced.map(plan => <article key={plan.id} className={plansCss.otherPlan} data-plan-id={plan.id}>
              <div>
                <div className={plansCss.cardName}>
                  <h3>{plan.name}</h3>
                  <LimitedPlanBadge plan={plan} t={props.t} />
                </div>
                {plan.description && <p>{plan.description}</p>}
              </div>
              <Button variant="outline" className={plansCss.action} disabled={billing.busy || billing.purchase !== null}
                onClick={(event) => {
                  const subscription = owned.find(row => row.planId === plan.id)
                  if (current(plan) && subscription) {
                    props.manageSubscription(subscription.id === billing.selectedSubscription ? null : subscription)
                  } else {
                    choose(plan, event.currentTarget)
                  }
                }}
                aria-label={props.t(current(plan) ? 'managePlan' : 'viewPlanNamed', { name: plan.name })}>
                {props.t(current(plan) ? 'manage' : 'viewPlanNamed', { name: plan.name })}
              </Button>
            </article>)}
          </div>}
          {catalog.length === 0 && <div className={plansCss.empty}>
            <p>{props.t('plansEmpty')}</p>
            <Button variant="outline" className={plansCss.action} onClick={() =>{  props.billing(null, false) }}>
              {props.t('viewPlansWebsite')}<Glyph name="arrow-up-right" size={13} />
            </Button>
          </div>}
        </div>
      </section>
      {history.length > 0 && <div className={plansCss.history}>
        <button type="button" aria-expanded={historyOpen} aria-controls={historyId}
          onClick={(event) => {
            if (historyOpen) event.currentTarget.focus()
            setHistoryOpen(!historyOpen)
          }}>
          <Glyph name="clock-3" size={17} />{props.t('subscriptionHistory')}<span>{history.length}</span>
          <Glyph name="chevron-down" size={15} className={plansCss.disclosure} />
        </button>
        <div id={historyId} className={plansCss.panelMotion} data-open={historyOpen}
          {...{ inert: historyOpen ? undefined : '' }} aria-hidden={!historyOpen || undefined}>
          <div>{history.map(renderSubscription)}</div>
        </div>
      </div>}
    </>}
  </main>
}
