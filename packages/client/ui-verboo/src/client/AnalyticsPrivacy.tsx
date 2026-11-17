/** Product analytics choice remains independent from account access and advertising. */
import { useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProductAnalyticsStatus } from '@deepseek-ai/dsh-host-verboo-analytics/types'
import type { ProductProps } from './contracts.ts'
import css from './AnalyticsPrivacy.module.css'

/** Renderer-owned preference subscription and explicit user actions. */
export interface AnalyticsPrivacyInjected {
  hooks: { analyticsPrivacy: HostObservable<ProductAnalyticsStatus | null> }
  chooseProductAnalytics(decision: 'granted' | 'denied'): Promise<boolean>
}

/** Product-local preference controls; no scope secrets reach the browser. */
export type AnalyticsPrivacyProps = PropsLocale<'verboo'> & InjectFace<AnalyticsPrivacyInjected>

/** A compact non-modal choice; ignoring or dismissing never grants collection. */
export function AnalyticsPrompt(props: PropsRuntime<'shell.overlay'> & ProductProps & AnalyticsPrivacyProps) {
  const product = props.useProduct(value => value)
  const status = props.useAnalyticsPrivacy(value => value)
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || !product.initialized || !product.profilePreviouslyVerified || status?.consent?.enabled !== true || status.consent.decision !== 'unknown') return null
  return <aside className={css.card} aria-label={props.t('analyticsTitle')} data-verboo-analytics-choice>
    <div className={css.heading}>
      <h2>{props.t('analyticsTitle')}</h2>
      <button type="button" aria-label={props.t('close')} onClick={() => { setDismissed(true) }}>×</button>
    </div>
    <p>{props.t('analyticsDescription')}</p>
    <AnalyticsChoice {...props} />
  </aside>
}

/** Persistent settings entry allows refusal and revocation after onboarding. */
export function AnalyticsPreferences(props: AnalyticsPrivacyProps) {
  const status = props.useAnalyticsPrivacy(value => value)
  return <section className={css.preferences}>
    <h2>{props.t('analyticsPreferences')}</h2>
    <p>{props.t('analyticsDescription')}</p>
    <p>{props.t(status?.consent?.decision === 'granted' ? 'analyticsAllowed' : status?.consent?.decision === 'denied' ? 'analyticsDenied' : 'analyticsUnknown')}</p>
    <AnalyticsChoice {...props} />
  </section>
}

/** Explicit choices share the same failure presentation in prompt and settings. */
export function AnalyticsChoice(props: AnalyticsPrivacyProps) {
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const choose = async (decision: 'granted' | 'denied') => {
    setSaving(true)
    setFailed(false)
    try { setFailed(!(await props.chooseProductAnalytics(decision))) }
    catch (_error) { setFailed(true) /* The Host remains the only collection policy owner. */ }
    finally { setSaving(false) }
  }
  return <>
    <div className={css.actions}>
      <button type="button" disabled={saving} className={css.reject} onClick={() => { void choose('denied') }}>{props.t('analyticsReject')}</button>
      <button type="button" disabled={saving} className={css.accept} onClick={() => { void choose('granted') }}>{props.t('analyticsAccept')}</button>
    </div>
    {failed && <p role="alert">{props.t('analyticsSaveFailed')}</p>}
  </>
}
