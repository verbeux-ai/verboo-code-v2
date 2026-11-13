import { useState } from 'react'
import { Button, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Plan, Subscription } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { PageProps, ProductProps } from './contracts.ts'
import type { Key } from './locales.ts'
import { Glyph } from './Glyph.tsx'
import { Busy, Notice } from './PageParts.tsx'
import css from './Product.module.css'
import plansCss from './Plans.module.css'

type PlanActions = Pick<ProductProps, 't' | 'billing'>
type PlanPageProps = Pick<PageProps, 'useProduct' | 'usePreferences' | 't' | 'loadPlans' | 'billing'>
  & Pick<PageProps, 'useExternalStatus' | 'openOpenAiDialog'>
const money = (amount: number, currency: string, locale: string) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 100)
const currentStatuses = ['active', 'trialing', 'past_due', 'incomplete', 'paused']
const historical = (subscription: Subscription) =>
  subscription.status === 'canceled' || subscription.status === 'incomplete_expired'
const subscriptionKey = (status: string): Key =>
  status === 'incomplete_expired' ? 'planExpired' :
    [...currentStatuses, 'unpaid', 'canceled'].includes(status) ? status as Key : 'planUnknown'

function SubscriptionRow({ subscription, locale, t, billing }: PlanActions & {
  subscription: Subscription
  locale: string
}) {
  const needsAttention = ['past_due', 'unpaid', 'incomplete', 'incomplete_expired'].includes(subscription.status)
  return <article className={plansCss.subscription} data-subscription-status={subscription.status}>
    <div className={plansCss.subscriptionIdentity}>
      <h3>{subscription.name}</h3>
      <span className={plansCss.status} data-attention={needsAttention}>
        {t(subscriptionKey(subscription.status))}
      </span>
      {subscription.renewsAt && <p>
        {t(subscription.cancelAtEnd || historical(subscription) ? 'ends' : 'renews')}{' '}
        {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(subscription.renewsAt))}
      </p>}
    </div>
    {subscription.billing && <p className={plansCss.subscriptionPrice}>
      {money(subscription.billing.amountMinor, subscription.billing.currency, locale)}
      <span>{t(subscription.billing.interval === 'year' ? 'yearly' : 'monthly')}</span>
    </p>}
    <Button variant="outline" className={plansCss.action} onClick={() =>{  billing(subscription.planId, false) }}
      aria-label={t('managePlan', { name: subscription.name })}>
      {t('manage')}<Glyph name="arrow-up-right" size={13} />
    </Button>
  </article>
}

function PlanCard({ plan, current, locale, t, billing }: PlanActions & {
  plan: Plan
  current: boolean
  locale: string
}) {
  return <article className={plansCss.card} data-plan-id={plan.id} data-current={current}>
    <div className={plansCss.cardHead}>
      <h3>{plan.name}</h3>
    </div>
    <p className={plansCss.price}>
      <strong>{money(plan.priceCents, plan.currency, locale)}</strong>
      <span>{t(plan.interval === 'year' ? 'yearly' : 'monthly')}</span>
    </p>
    <Button variant={current ? 'outline' : 'primary'} className={plansCss.choose}
      disabled={current} onClick={() =>{  billing(plan.id, true) }}
      aria-label={current ? t('currentPlanNamed', { name: plan.name }) : t('choosePlanNamed', { name: plan.name })}>
      {current && <Glyph name="check" size={13} />}{t(current ? 'currentPlan' : 'buyPlan')}
    </Button>
    {plan.description && <p className={plansCss.description}>{plan.description}</p>}
  </article>
}

/** Compare server-priced plans; checkout and management retain the existing authenticated browser handoff. */
export function PlanPage(props: PlanPageProps) {
  const plans = props.useProduct(s => s.plans)
  const failed = props.useProduct(s => s.plansFailed)
  const loading = props.useProduct(s => s.loadingPlans)
  const handoff = props.useProduct(s => s.handoff)
  const locale = props.usePreferences(s => s.locale)
  const external = props.useExternalStatus(s => s)
  const [selectedInterval, setSelectedInterval] = useState('month')
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
  const current = (plan: Plan) => owned.some(s => s.planId === plan.id && currentStatuses.includes(s.status))

  return <main className={`${css.page} ${plansCss.page}`} data-verboo-page="plan">
    <header className={plansCss.header}>
      <div><h1>{props.t('plansTitle')}</h1><p>{props.t('planDescription')}</p></div>
      <Button variant="ghost" size="sm" className={plansCss.refresh} disabled={loading} title={props.t('refresh')}
        aria-label={props.t('refresh')} onClick={props.loadPlans}>
        <Glyph name="rotate-cw" size={16} className={loading ? css.spin : undefined} />
      </Button>
    </header>
    {failed && <Notice error text={props.t('unavailable')} retry={props.loadPlans} label={props.t('retry')} />}
    {handoff === 'billing' && <Notice text={props.t('purchasePending')} retry={props.loadPlans} label={props.t('refresh')} />}
    {plans === null ? loading && <Busy label={props.t('loading')} /> : <>
      {owned.length > 0 ? <section className={plansCss.owned} aria-label={props.t('yourSubscriptions')}>
        <h2>{props.t('yourSubscriptions')}</h2>
        {owned.map(subscription => <SubscriptionRow key={subscription.id} subscription={subscription}
          locale={locale} t={props.t} billing={props.billing} />)}
      </section> : <p className={plansCss.noPlan}>{props.t('noPlan')}. {props.t('noPlanDescription')}</p>}
      {<section className={plansCss.owned} aria-label={props.t('openAiExternalTitle')}>
        <h2>{props.t('openAiExternalTitle')}</h2>
        <article className={plansCss.subscription} data-external="openai">
          <div className={plansCss.subscriptionIdentity}>
            <h3>{external.signedIn && external.planType !== undefined
              ? props.t('openAiPlanNamed').replace('{plan}', external.planType)
              : props.t('openAiPlan')}</h3>
            <span className={plansCss.status}>{external.signedIn
              ? props.t('openAiConnected')
              : props.t('openAiDisconnected')}</span>
            {external.activeUntil !== undefined && <p>
              {props.t('openAiActiveUntil').replace('{date}',
                new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(external.activeUntil)))}
            </p>}
          </div>
          <Button variant="outline" className={plansCss.action} onClick={props.openOpenAiDialog}>
            {props.t('openAiManage')}<Glyph name="arrow-up-right" size={13} />
          </Button>
        </article>
      </section>}
      <section className={plansCss.catalog} aria-labelledby="verboo-plans-heading">
        <div className={plansCss.catalogHead}>
          <h2 id="verboo-plans-heading">{props.t('availablePlans')}</h2>
          {intervals.length > 1 && <SegmentedControl id="verboo-billing" value={interval ?? 'month'}
            label={props.t('billingInterval')} className={plansCss.interval}
            options={intervals.map(value => ({ value, label: props.t(value === 'year' ? 'annualBilling' : 'monthlyBilling') }))}
            onChange={setSelectedInterval} />}
        </div>
        <div id={`verboo-billing-${interval}-panel`} role={intervals.length > 1 ? 'tabpanel' : undefined}
          aria-labelledby={intervals.length > 1 ? `verboo-billing-${interval}` : undefined}>
          {priced.length > 0 && <div className={plansCss.grid}>
            {priced.map(plan => <PlanCard key={plan.id} plan={plan} current={current(plan)}
              locale={locale} t={props.t} billing={props.billing} />)}
          </div>}
          {unpriced.length > 0 && <div className={plansCss.otherPlans}>
            {unpriced.map(plan => <article key={plan.id} className={plansCss.otherPlan} data-plan-id={plan.id}>
              <div><h3>{plan.name}</h3>{plan.description && <p>{plan.description}</p>}</div>
              <Button variant="outline" className={plansCss.action} onClick={() =>{  props.billing(plan.id, !current(plan)) }}
                aria-label={props.t(current(plan) ? 'managePlan' : 'viewPlanNamed', { name: plan.name })}>
                {props.t(current(plan) ? 'manage' : 'priceOnWebsite')}<Glyph name="arrow-up-right" size={13} />
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
      <p className={plansCss.billingNote}><Glyph name="arrow-up-right" size={13} />{props.t('billingNote')}</p>
      {history.length > 0 && <details className={plansCss.history}>
        <summary><Glyph name="chevron-right" size={14} />{props.t('subscriptionHistory')}<span>{history.length}</span></summary>
        {history.map(subscription => <SubscriptionRow key={subscription.id} subscription={subscription}
          locale={locale} t={props.t} billing={props.billing} />)}
      </details>}
    </>}
  </main>
}
