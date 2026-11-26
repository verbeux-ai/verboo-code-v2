import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlanId, Result, Subscription, UsageActivityDay, UsagePeriod, UsageSummary, SpeedFrame, SpeedMeasurement } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { PageProps } from './contracts.ts'
import { Notice, PageHead, ReadFailure } from './PageParts.tsx'
import { StaminaPanel } from './Stamina.tsx'
import { staminaAddress } from './stamina-resource.ts'
import type { Key } from './locales.ts'
import base from './Product.module.css'
import css from './Analytics.module.css'

/** Authenticated, account-fenced Host readers; no access token reaches this page. */
export interface AnalyticsActions {
  summary(period: UsagePeriod, group: PlanId | null, signal: AbortSignal): Promise<Result<UsageSummary>>
  activity(signal: AbortSignal): Promise<Result<UsageActivityDay[]>>
  speed(signal: AbortSignal): AsyncIterable<SpeedFrame>
}
type Props = PageProps & AnalyticsActions
const periods: readonly { id: UsagePeriod; key: Key }[] = [
  { id: '24h', key: 'analytics24h' }, { id: '7d', key: 'analytics7d' },
  { id: '30d', key: 'analytics30d' }, { id: 'current_month', key: 'analyticsCurrentMonth' },
  { id: 'previous_month', key: 'analyticsPreviousMonth' },
]
type UsageRead = { owner: string; period: UsagePeriod; total: Result<UsageSummary>; groups: Record<string, Result<UsageSummary>> }
type ActivityRead = { owner: string; value: Result<UsageActivityDay[]> }

function activeSubscriptions(rows: Subscription[]): Subscription[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (!['active', 'trialing'].includes(row.status) || (row.renewsAt !== null && !(Date.parse(row.renewsAt) > Date.now())) || seen.has(row.planId)) return false
    seen.add(row.planId)
    return true
  })
}
function dateKey(date: Date): string {
  const part = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`
}

/** A page-scoped view; retired requests cannot publish another account or period. */
export function AnalyticsPage(props: Props) {
  const account = props.useProduct(value => value)
  const locale = props.usePreferences(value => value.locale)
  const owner = staminaAddress(account)
  const [period, setPeriod] = useState<UsagePeriod>('30d')
  const [revision, setRevision] = useState(0)
  const [usage, setUsage] = useState<UsageRead | null>(null)
  const [activity, setActivity] = useState<ActivityRead | null>(null)
  const [speed, setSpeed] = useState<{ owner: string; online: boolean; measurement: SpeedMeasurement | null } | null>(null)
  const actions = useRef(props)
  actions.current = props
  const subscriptions = activeSubscriptions(account.plans?.subscriptions ?? [])
  const planKey = JSON.stringify(subscriptions.map(row => row.planId))
  useEffect(() => { if (owner) actions.current.loadPlans() }, [owner])
  useEffect(() => {
    if (!owner) return
    const controller = new AbortController()
    const stopped = () => controller.signal.aborted
    const ids = JSON.parse(planKey) as PlanId[]
    const run = async () => {
      const safe = async (group: PlanId | null): Promise<Result<UsageSummary>> => {
        try { return await actions.current.summary(period, group, controller.signal) }
        catch { return { ok: false, code: 'request_failed' } }
      }
      const byGroup: Record<string, Result<UsageSummary>> = {}
      let next = 0
      const worker = async () => {
        while (!stopped() && next < ids.length) {
          const id = ids[next++]
          const value = await safe(id)
          if (stopped()) return
          byGroup[id] = value
          setUsage(previous => previous?.owner === owner && previous.period === period
            ? { ...previous, groups: { ...previous.groups, [id]: value } } : previous)
        }
      }
      const total = safe(null).then((value) => {
        if (!controller.signal.aborted) setUsage({ owner, period, total: value, groups: { ...byGroup } })
      })
      await Promise.all([total, ...Array.from({ length: Math.min(4, ids.length) }, worker)])
    }
    void run()
    return () => { controller.abort() }
  }, [owner, period, planKey, revision])
  useEffect(() => {
    if (!owner) return
    const controller = new AbortController()
    void actions.current.activity(controller.signal).catch((): Result<UsageActivityDay[]> => ({ ok: false, code: 'request_failed' }))
      .then((value) => { if (!controller.signal.aborted) setActivity({ owner, value }) })
    return () => { controller.abort() }
  }, [owner, revision])
  useEffect(() => {
    if (!owner) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let wake: (() => void) | undefined
    const stopped = () => controller.signal.aborted
    const run = async () => {
      let retry = 0
      while (!stopped()) {
        try {
          for await (const frame of actions.current.speed(controller.signal)) {
            if (stopped()) return
            retry = 0
            setSpeed(previous => ({ owner, online: !frame.stale, measurement: frame.stale ? null : frame.measurement ??
              (previous?.owner === owner && previous.online && previous.measurement
                ? { ...previous.measurement, previous: true } : null) }))
          }
        } catch { /* A disconnected stream is retried without exposing transport details. */ }
        if (stopped()) return
        setSpeed({ owner, online: false, measurement: null })
        await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, Math.min(1000 * 2 ** retry++, 30000)) })
      }
    }
    void run()
    return () => { controller.abort(); clearTimeout(timer); wake?.() }
  }, [owner])
  const current = usage?.owner === owner && usage.period === period ? usage : null
  const history = activity?.owner === owner ? activity.value : null
  const total = current?.total.ok ? current.total.data : null
  const number = new Intl.NumberFormat(locale)
  const retry = () => { props.loadPlans(); props.refreshStamina(); setRevision(value => value + 1) }
  if (!owner && account.view?.status === 'credential-stored' && (account.accountFailed || account.profile?.id === null)) {
    return <main className={`${base.page} ${css.page}`} data-verboo-page="analytics">
      <PageHead title={props.t('analytics')} description={props.t('analyticsSubtitle')} t={props.t} />
      <Notice error text={props.t('analyticsFailure')} retry={props.retryAccount} label={props.t('retry')} />
    </main>
  }
  return <main className={`${base.page} ${css.page}`} data-verboo-page="analytics">
    <PageHead title={props.t('analytics')} description={props.t('analyticsSubtitle')} t={props.t} onRefresh={retry} />
    <StaminaPanel {...props} />
    <SpeedCard value={speed?.owner === owner ? speed : null} locale={locale} t={props.t} />
    <section className={css.card} aria-label={props.t('analyticsActivity')}>
      <h2>{props.t('analyticsActivity')}</h2><p>{props.t('analyticsActivityDesc')}</p>
      {history === null ? <p role="status">{props.t('analyticsLoading')}</p> : !history.ok
        ? <div role="alert">{props.t('analyticsActivityFailure')} <button className={css.retry} onClick={retry}>{props.t('retry')}</button></div>
        : <ActivityGrid rows={history.data} locale={locale} t={props.t} />}
    </section>
    <section aria-label={props.t('analyticsUsage')}>
      <div className={css.sectionHead}><h2>{props.t('analyticsUsage')}</h2>
        <label>{props.t('analyticsPeriod')} <select value={period} onChange={(event) => { setPeriod(event.target.value as UsagePeriod) }}>
          {periods.map(option => <option key={option.id} value={option.id}>{props.t(option.key)}</option>)}
        </select></label>
      </div>
      {current === null ? <div className={css.card} role="status">{props.t('analyticsLoading')}</div> : !current.total.ok
        ? current.total.code === 'signed_out'
          ? <ReadFailure kind="plans" reason="signed_out" hasPrevious={false} retry={retry} signIn={props.start} t={props.t} />
          : <div className={css.card} role="alert">{props.t('analyticsFailure')} <button className={css.retry} onClick={retry}>{props.t('retry')}</button></div>
        : total && <>
          <div className={css.metrics}>
            {([['analyticsInput', total.tokensInTotal], ['analyticsOutput', total.tokensOutTotal], ['analyticsCache', total.cachedTokens], ['analyticsRequests', total.reqTotal]] as const).map(([key, value]) =>
              <div className={css.metric} key={key}><span>{props.t(key)}</span><strong>{number.format(value)}</strong></div>)}
          </div>
          <UsageChart summary={total} locale={locale} t={props.t} />

        </>}
    </section>
    <section className={css.card}><h2>{props.t('analyticsPlanUsage')}</h2>
      {account.plans === null ? <p>{props.t(account.plansFailed ? 'planUnavailable' : 'analyticsLoading')}</p> : subscriptions.length === 0
        ? <p>{props.t('analyticsNoPlans')}</p> : subscriptions.map((row) => {
          const result = current?.groups[row.planId]
          return <div className={css.plan} key={row.planId}><strong>{row.name}</strong>
            {result === undefined ? <span>{props.t('analyticsLoading')}</span> : !result.ok ? <span>{props.t('analyticsPlanFailure')} <button className={css.retry} onClick={retry}>{props.t('retry')}</button></span>
              : <span>{props.t('analyticsInput')}: {number.format(result.data.tokensInTotal)} · {props.t('analyticsOutput')}: {number.format(result.data.tokensOutTotal)}</span>}
          </div>
        })}
    </section>
  </main>
}

function SpeedCard({ value, locale, t }: { value: { online: boolean; measurement: SpeedMeasurement | null } | null; locale: string; t: PageProps['t'] }) {
  const measurement = value?.online ? value.measurement : null
  const time = measurement ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(measurement.at)) : ''
  const hint = !value?.online ? t('analyticsSpeedOffline') : !measurement ? t('analyticsSpeedWaiting') : measurement.previous
    ? t('analyticsSpeedPrevious', { time }) : measurement.partial ? t('analyticsSpeedPartial') : measurement.quality === 'estimated' ? t('analyticsSpeedEstimated') : t('analyticsSpeedLive')
  return <section className={`${css.card} ${css.speed}`} aria-label={t('analyticsSpeed')}>
    <div><h2>{t('analyticsSpeed')}</h2><p>{t('analyticsSpeedDescription')}</p>
      <div className={css.speedValue}><strong>{measurement ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(measurement.value) : '—'}</strong><span>{t('analyticsSpeedUnit')}</span></div>
      <p role="status">{hint}</p>
    </div><div className={css.speedArt} data-active={Boolean(measurement && !measurement.previous)} aria-hidden="true"><span /><span /><span /><i>➜</i></div>
  </section>
}

function ActivityGrid({ rows, locale, t }: { rows: UsageActivityDay[]; locale: string; t: PageProps['t'] }) {
  const today = new Date()
  const { weeks, months, max } = useMemo(() => {
    const counts = new Map(rows.map(row => [row.date, row.count]))
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 364)
    const columns: ({ date: Date; count: number } | null)[][] = []
    const labels: { column: number; label: string }[] = []
    let column: ({ date: Date; count: number } | null)[] = Array<null>(start.getDay()).fill(null)
    let maximum = 0
    for (let offset = 0; offset < 365; offset++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset)
      const count = counts.get(dateKey(date)) ?? 0
      maximum = Math.max(maximum, count)
      if (date.getDate() === 1) labels.push({ column: columns.length, label: new Intl.DateTimeFormat(locale, { month: 'short' }).format(date) })
      column.push({ date, count })
      if (column.length === 7) { columns.push(column); column = [] }
    }
    if (column.length) columns.push([...column, ...Array<null>(7 - column.length).fill(null)])
    return { weeks: columns, months: labels, max: maximum }
  }, [rows, locale, today.getFullYear(), today.getMonth(), today.getDate()])
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => { if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth }, [weeks])
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
  return <><div className={css.activityScroll} ref={scroll}><div className={css.calendar} role="img" aria-label={t('analyticsActivityLabel')}>
    <div className={css.months}>{months.map(month => <span key={`${month.column}-${month.label}`} style={{ left: `${30 + month.column * 14}px` }}>{month.label}</span>)}</div>
    <div className={css.calendarBody}><div className={css.weekLabels} aria-hidden="true">{Array.from({ length: 7 }, (_, day) => <span key={day}>{day % 2 === 1 ? new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(2024, 0, 7 + day)) : ''}</span>)}</div>
      <div className={css.weeks}>{weeks.map((week, index) => <div className={css.week} key={index}>{week.map((cell, day) => {
        const level = !cell || cell.count === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((cell.count / max) * 4)))
        return <span key={day} className={css.day} data-level={cell ? level : undefined} data-empty={!cell || undefined} title={cell ? t('analyticsDay', { date: fmt.format(cell.date), count: String(cell.count) }) : undefined} />
      })}</div>)}</div></div>
  </div></div><div className={css.legend}><span>{t('analyticsLess')}</span>{[0, 1, 2, 3, 4].map(level => <span className={css.day} data-level={level} key={level} />)}<span>{t('analyticsMore')}</span></div></>
}

function UsageChart({ summary, locale, t }: { summary: UsageSummary; locale: string; t: PageProps['t'] }) {
  const max = Math.max(0, ...summary.buckets.map(bucket => bucket.tokensIn + bucket.tokensOut))
  const formatter = new Intl.NumberFormat(locale)
  const label = (value: string) => {
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return value
    try { return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...(summary.bucket === 'hour' ? { hour: '2-digit', minute: '2-digit' } : {}), timeZone: summary.timezone }).format(date) }
    catch { return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date) }
  }
  return <section className={css.card}><h2>{t('analyticsChart')}</h2><p>{t('analyticsChartTotal')}</p>
    {max === 0 ? <p>{t('analyticsNoData')}</p> : <div className={css.chartScroll}><div className={css.chart} role="img" aria-label={t('analyticsChartLabel')}>
      {summary.buckets.map((bucket, index) => <div className={css.column} key={`${bucket.bucket}-${index}`} title={`${label(bucket.bucket)} · ${t('analyticsInput')}: ${formatter.format(bucket.tokensIn)} · ${t('analyticsOutput')}: ${formatter.format(bucket.tokensOut)} · ${t('analyticsRequests')}: ${formatter.format(bucket.reqCount)}`}>
        <div className={css.bar} style={{ height: `${Math.max(1, (bucket.tokensIn + bucket.tokensOut) / max * 100)}%` }} />
      </div>)}
    </div><div className={css.axis}><span>{label(summary.buckets[0]?.bucket ?? '')}</span><span>{label(summary.buckets.at(-1)?.bucket ?? '')}</span></div></div>}
  </section>
}
