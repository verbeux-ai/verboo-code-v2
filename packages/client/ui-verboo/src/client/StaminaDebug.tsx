/** Opt-in diagnostics read the same account resource as the water indicator. */
import { useState } from 'react'
import type { PropsRuntime, HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config } from '../config.ts'
import type { ProductProps } from './contracts.ts'
import { staminaAddress } from './stamina-resource.ts'
import { selectStaminaForModel, type SelectedStamina, type StaminaModelProps } from './stamina-selection.ts'
import css from './StaminaDebug.module.css'

type DebugLabels = Pick<ProductProps, 't'>

/** Host-backed debug preference exposed through renderer-owned hooks. */
export interface StaminaDebugInjected {
  hooks: { staminaDebug: HostObservable<ConfigFormSnapshot<Pick<Config, 'staminaDebug'>>> }
  /** Request another reading through the shared account resource. */
  refreshStamina(): void
  /** Persist opt-in diagnostics; false means the Host refused or could not save. */
  setStaminaDebug(enabled: boolean): Promise<boolean>
}

/** Localized controls sharing the accepted Host preference. */
export type StaminaDebugProps = PropsLocale<'verboo'> & InjectFace<StaminaDebugInjected>

/** Account-owned readings remain reactive while a response is running. */
export function StaminaDebug(props: PropsRuntime<'conversation.composer.dock'> & ProductProps & StaminaDebugProps & StaminaModelProps) {
  const address = props.useProduct(staminaAddress)
  const plans = props.useProduct(state => state.plans)
  const model = props.useStaminaModel(state => state.current)
  const resource = props.useResource<'verboo-stamina'>(address)
  const locale = props.usePreferences(state => state.locale)
  const enabled = props.useStaminaDebug(state => state.value?.staminaDebug === true)
  if (!enabled) return null
  const selected = selectStaminaForModel(plans, model, resource.value)
  return <StaminaDebugReading {...selected} failed={resource.status === 'failed'} locale={locale} t={props.t} refresh={props.refreshStamina} />
}

/** The switch changes only diagnostic presentation, never account consumption. */
export function StaminaDebugToggle(props: StaminaDebugProps) {
  const setting = props.useStaminaDebug(state => state)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  return <div className={css.toggle}>
    <label>
      <span>{props.t('staminaDebugTitle')}</span>
      <input
        type="checkbox"
        checked={setting.value?.staminaDebug === true}
        disabled={saving || setting.status !== 'ready' || !setting.writable}
        onChange={(event) => {
          setSaving(true)
          setFailed(false)
          void props.setStaminaDebug(event.currentTarget.checked).then((ok) => {
            setFailed(!ok)
            setSaving(false)
          })
        }}
      />
    </label>
    {failed && <span role="alert">{props.t('staminaDebugSaveFailed')}</span>}
  </div>
}

/** Raw server percentages are neither rounded nor inferred from local tokens. */
export function StaminaDebugReading({ group, reading, failed, locale, t, refresh }: DebugLabels & SelectedStamina & {
  failed: boolean
  locale: string
  refresh(): void
}) {
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'medium' })
  return (
    <output className={css.debug} aria-label={t('staminaDebugTitle')} aria-live="off" data-verboo-stamina-debug>
      <span>{t('staminaDebugTitle')}</span>
      {reading && group ? <span className={css.reading}>
        <code>{t('staminaDebugValue', { name: group.name, percent: String(reading.remainingPercent) })}</code>
        <time dateTime={reading.asOf}>{t('staminaDebugUpdated', { time: time.format(new Date(reading.asOf)) })}</time>
        {reading.accountingPending && <span>{t('staminaDebugPending')}</span>}
      </span> : <span>{failed ? t('staminaDebugFailed') : group
        ? t('staminaDebugGroupEmpty', { name: group.name }) : t('staminaDebugEmpty')}</span>}
      {reading && failed ? <span>{t('staminaStale')}</span> : null}
      <button type="button" onClick={refresh}>{t('refresh')}</button>
    </output>
  )
}
