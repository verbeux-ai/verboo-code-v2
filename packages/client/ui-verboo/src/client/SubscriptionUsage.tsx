/**
 * The composer's external-subscription reading: a pill that appears only once
 * the reading matters, and a panel holding the detail behind it.
 *
 * The healthy window stays silent, so the dock keeps its resting height and the
 * composer is not turned into a dashboard. Purple is the Verboo plan's accent
 * and never appears here: this reading belongs to an external subscription, and
 * the two must not read as the same control.
 */
import { Fragment, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductProps } from './contracts.ts'
import type { SubscriptionUsage as Reading, SubscriptionUsageState } from './subscription-usage-resource.ts'
import { CODEX_PROVIDER, subscriptionUsageAddress, subscriptionUsageVisible } from './subscription-usage-resource.ts'
import type { StaminaModelProps } from './stamina-selection.ts'
import css from './SubscriptionUsage.module.css'

/** The account identity the reading is addressed by, plus the accepted route. */
export type SubscriptionUsageProps = ProductProps & StaminaModelProps & {
  /** Product snapshot hook carrying the credential revision the address is built from. */
  readonly useSubscriptionUsageAddress: ProductProps['useProduct']
}

/**
 * Format the reset countdown as a duration the reader can act on.
 *
 * The units come from the locale rather than from the source, so a language
 * that spells hours and minutes differently is not left with English
 * abbreviations.
 * @param seconds - seconds until the window resets, or null when unknown.
 * @param locale - BCP-47 tag of the interface language.
 * @returns a short localized duration, or undefined when the provider stated none.
 */
function resetText(seconds: number | undefined, locale: string): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined
  const minutes = Math.ceil(seconds / 60)
  const short = new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'short' })
  if (minutes < 60) return short.format(minutes)
  const hours = new Intl.NumberFormat(locale, { style: 'unit', unit: 'hour', unitDisplay: 'short' })
  const whole = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? hours.format(whole) : `${hours.format(whole)} ${short.format(rest)}`
}

/**
 * @param props - the reading, its freshness, the accepted provider, and the locale seat.
 * @returns the pill and its panel, or null while the reading is not worth showing.
 */
export function SubscriptionUsage(props: PropsRuntime<'conversation.composer.dock'> & SubscriptionUsageProps) {
  const [open, setOpen] = useState(false)
  const address = props.useSubscriptionUsageAddress(subscriptionUsageAddress)
  const model = props.useStaminaModel(state => state.current)
  const resource = props.useResource<'verboo-subscription-usage'>(address)
  const usage: Reading | undefined = resource.value
  // Only the external subscription's own route carries this reading; a Verboo
  // model leaves the dock untouched rather than showing a borrowed number.
  if (model?.provider !== CODEX_PROVIDER || usage === undefined) return null
  const stale = resource.status === 'failed'
  const state = stateOf(usage)
  if (!subscriptionUsageVisible(state)) return null
  const plan = usage.planType == null ? props.t('subscription.plan') : props.t('subscription.planNamed', { plan: usage.planType })
  const reset = resetText(usage.resetAfterSeconds, props.usePreferences(state => state.locale))
  const label = state === 'unlimited'
    ? props.t('subscription.unlimited', { plan })
    : state === 'exhausted'
      ? props.t('subscription.exhausted', { plan })
      : props.t('subscription.used', { plan, percent: String(Math.round(usage.usedPercent)) })
  return (
    <span className={css.host} data-verboo-subscription-usage data-state={state} data-stale={stale || undefined}>
      <button
        type="button"
        className={css.pill}
        aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className={css.dot} aria-hidden="true" />
        <span className={css.text}>{label}</span>
        {state === 'warn' && reset !== undefined && <span className={css.reset}>{reset}</span>}
      </button>
      {open && (
        <Fragment>
          <span className={css.scrim} role="presentation" onClick={() => { setOpen(false) }} />
          <div className={css.panel} role="dialog" aria-label={plan}>
            <p className={css.heading}>{label}</p>
            <dl className={css.rows}>
              {usage.resetAfterSeconds != null && (
                <Fragment>
                  <dt>{props.t('subscription.resetsIn')}</dt>
                  <dd>{reset ?? props.t('subscription.unknown')}</dd>
                </Fragment>
              )}
              {usage.credits != null && (
                <Fragment>
                  <dt>{props.t('subscription.credits')}</dt>
                  <dd>{String(usage.credits)}</dd>
                </Fragment>
              )}
              <dt>{props.t('subscription.asOf')}</dt>
              <dd>{new Date(usage.asOf).toLocaleTimeString()}</dd>
            </dl>
            {stale && <p className={css.stale}>{props.t('subscription.stale')}</p>}
          </div>
        </Fragment>
      )}
    </span>
  )
}

/**
 * Classify one reading for the control's own presentation.
 * @param usage - a confirmed reading.
 * @returns the state the pill paints.
 */
function stateOf(usage: Reading): SubscriptionUsageState {
  if (usage.unlimited) return 'unlimited'
  if (usage.reachedType != null || usage.usedPercent >= 100) return 'exhausted'
  return usage.usedPercent >= 80 ? 'warn' : 'normal'
}
