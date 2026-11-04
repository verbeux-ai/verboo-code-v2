/** Stamina displays the server's next-request ceiling separately from observed generation speed. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PageProps, ProductProps } from './contracts.ts'
import type { StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import { staminaAddress } from './stamina-resource.ts'
import css from './Stamina.module.css'

type StaminaProps = Pick<PageProps, 'useProduct' | 'usePreferences' | 'useResource' | 't' | 'refreshStamina'>

/** Enrolled-plan details on My plan; a missing or disabled policy renders no bar. */
export function StaminaPanel(props: StaminaProps) {
  return <Stamina {...props} compact={false} />
}

/** Account stamina below the active composer, including on narrow viewports. */
export function StaminaDock(props: PropsRuntime<'conversation.composer.dock'> & ProductProps) {
  return <Stamina {...props} compact />
}

function Stamina({ compact, ...props }: StaminaProps & { compact: boolean }) {
  const account = props.useProduct(state => state)
  const locale = props.usePreferences(state => state.locale)
  const resource = props.useResource<'verboo-stamina'>(staminaAddress(account))
  return <StaminaDisplay rows={resource.value} failed={resource.status === 'failed'} compact={compact} locale={locale} t={props.t} refreshStamina={props.refreshStamina} />
}

/** Public stamina readings; unknown eligibility never produces a filled progress bar. */
export function StaminaDisplay({ rows, failed, compact, locale, ...props }: Pick<StaminaProps, 't' | 'refreshStamina'> & {
  rows: StaminaStatus[] | undefined
  failed: boolean
  compact: boolean
  locale: string
}) {
  if (rows?.length === 0 || rows === undefined && (compact || !failed)) return null
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  return (
    <section className={compact ? css.compact : css.panel} aria-label={props.t('staminaTitle')} data-verboo-stamina>
      {!compact && <h2>{props.t('staminaTitle')}</h2>}
      {failed && (
        <div className={css.notice} role="status">
          <span>{props.t(rows === undefined ? 'staminaUnavailable' : 'staminaStale')}</span>
          <button className={css.retry} onClick={props.refreshStamina}>{props.t('retry')}</button>
        </div>
      )}
      {rows?.map(row => (
        <div className={css.reserve} key={row.groupId}>
          <div className={css.heading}>
            <span>{row.groupName}</span>
            <span>{props.t('staminaRemaining', { percent: number.format(row.remainingPercent) })}</span>
          </div>
          <progress className={css.bar} max={100} value={row.remainingPercent} aria-label={`${props.t('staminaTitle')}: ${row.groupName}`} />
          <p className={css.ceiling}>{props.t('staminaNextLimit', { tps: number.format(row.nextOutputTps) })}</p>
          {!compact && <>
            <p className={css.description}>{props.t(row.recovering ? 'staminaRecovering' : row.remainingPercent >= 100 ? 'staminaFull' : 'staminaInUse')}</p>
            {row.recovering && row.fullAt !== null && <p className={css.description}>{props.t('staminaFullAt', { time: new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(new Date(row.fullAt)) })}</p>}
            <p className={css.description}>{props.t('staminaExplanation')}</p>
          </>}
          {row.accountingPending && <p className={css.description} role="status">{props.t('staminaPending')}</p>}
        </div>
      ))}
    </section>
  )
}
