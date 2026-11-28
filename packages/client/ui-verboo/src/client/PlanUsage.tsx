/** Allowance windows reported by the central API for the signed-in account. */
import type { PageProps } from './contracts.ts'
import type { Subscription } from '@deepseek-ai/dsh-api-verboo-product/types'
import { usageWindowsAddress } from './usage-windows-resource.ts'
import css from './Plans.module.css'

/** Refresh action for the allowance read mounted by Plans. */
export interface PlanUsageActions {
  refreshUsageWindows(this: void): void
}

type PlanUsageProps = Pick<PageProps, 'useProduct' | 'usePreferences' | 'useResource' | 't'> & PlanUsageActions
  & { subscriptions: Subscription[] }

function durationLabel(seconds: number, locale: string): string {
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]] as const
  const [unit, divisor] = units.find(([, size]) => seconds % size === 0) ?? ['second', 1]
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(seconds / divisor)
}

/**
 * Render the account's plan allowance without deriving limits from token totals.
 * @param props - account resource hooks, localized strings and refresh action.
 * @returns allowance rows or their current read status.
 */
export function PlanUsage({ useProduct, usePreferences, useResource, t, refreshUsageWindows, subscriptions }: PlanUsageProps) {
  const address = useProduct(usageWindowsAddress)
  const locale = usePreferences(state => state.locale)
  const { status, value } = useResource<'verboo-usage-windows'>(address)
  const rows = value?.filter(group => group.limited)
  if (address === '' || status === 'none' || rows?.length === 0 && status !== 'failed') return null

  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' })
  return <section className={css.owned} aria-label={t('planUsageTitle')}>
    <h2>{t('planUsageTitle')}</h2>
    {status === 'loading' && <p className={css.usageNote} role="status">{t('loading')}</p>}
    {status === 'failed' && <div className={css.usageHeading} role="status">
      <span>{t(rows === undefined ? 'planUsageUnavailable' : 'planUsageStale')}</span>
      <button type="button" className={css.usageRetry} onClick={refreshUsageWindows}>{t('retry')}</button>
    </div>}
    {rows?.map((group) => {
      const { apiRateLimitRpm, concurrentRequests } = subscriptions.find(s => s.planId === group.groupId)?.limitedUsage ?? {}
      return <div key={group.groupId} className={css.usageGroup}>
        <h3>{group.groupName}</h3>
        {apiRateLimitRpm !== undefined && apiRateLimitRpm > 0 && <p className={css.usageNote}>
          {t('planRequestsPerMinute', { count: number.format(apiRateLimitRpm) })}
        </p>}
        {concurrentRequests !== undefined && concurrentRequests > 0 && <p className={css.usageNote}>
          {t('planConcurrentRequests', { count: number.format(concurrentRequests) })}
        </p>}
        {group.blocked && <p className={css.usageBlocked} role="status">
          {group.availableAt === null ? t('planUsageBlocked') : t('planUsageAvailableAt', { date: date.format(new Date(group.availableAt)) })}
        </p>}
        {group.accountingPending && <p className={css.usageNote} role="status">{t('planUsagePending')}</p>}
        {group.windows.map((window) => {
          const label = t('planUsageDuration', { duration: durationLabel(window.durationSeconds, locale) })
          const percent = window.usedPercent === 100 ? 100 : Math.min(window.usedPercent, 99.9)
          return <div className={css.usageWindow} key={window.id}>
            <div className={css.usageHeading}>
              <span>{label}</span>
              <span>{t('planUsageUsed', { percent: number.format(percent) })}</span>
            </div>
            <progress className={css.usageProgress} max={100} value={window.usedPercent} aria-label={t('planUsageProgress', { name: group.groupName, window: label })} />
            <p className={css.usageNote}>{window.resetsAt === null
              ? t('planUsageNotStarted')
              : t('planUsageResets', { date: date.format(new Date(window.resetsAt)) })}</p>
          </div>
        })}
      </div>
    })}
  </section>
}
