/** Server-confirmed stamina decorates Send/Stop without controlling submission. */
import { useLayoutEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ProductProps } from './contracts.ts'
import { staminaAddress } from './stamina-resource.ts'
import { selectStaminaForModel, type StaminaModelProps } from './stamina-selection.ts'
import css from './StaminaLiquid.module.css'

/** The primary-action slot keeps the host button's actions and accessible name. */
export function StaminaButtonFill(props: PropsRuntime<'conversation.input.primary.background'> & ProductProps & StaminaModelProps) {
  const address = props.useProduct(staminaAddress)
  const plans = props.useProduct(state => state.plans)
  const locale = props.usePreferences(state => state.locale)
  const model = props.useStaminaModel(state => state.current)
  const resource = props.useResource<'verboo-stamina'>(address)
  const selected = selectStaminaForModel(plans, model, resource.value)
  return <StaminaButtonReading
    key={`${address}/${selected.reading?.groupId ?? ''}`}
    reading={selected.reading}
    stale={resource.status === 'failed'}
    locale={locale}
    t={props.t}
    onDescriptionChange={props.onDescriptionChange}
  />
}

type ReadingLabels = Pick<ProductProps, 't'> & Pick<PropsRuntime<'conversation.input.primary.background'>, 'onDescriptionChange'> & { locale: string }

/** Only the selected group's confirmed reading paints the water. */
export function StaminaButtonReading({ reading, stale, ...labels }: ReadingLabels & {
  reading: StaminaStatus | undefined
  stale: boolean
}) {
  if (reading === undefined) return null
  return <>
    <StaminaButtonDescription reading={reading} stale={stale} {...labels} />
    <StaminaLiquid remainingPercent={reading.remainingPercent} stale={stale} />
  </>
}

function StaminaButtonDescription(
  { reading, stale, locale, t, onDescriptionChange }: ReadingLabels & { reading: StaminaStatus; stale: boolean },
) {
  const balance = useRef<{ previous?: number; lastDrop?: number }>({})
  const { remainingPercent, accountingPending, groupName } = reading
  useLayoutEffect(() => () => { onDescriptionChange(undefined) }, [onDescriptionChange])
  useLayoutEffect(() => {
    const current = balance.current
    if (!stale && !accountingPending) {
      const previous = current.previous
      if (previous !== undefined && remainingPercent !== previous) {
        if (remainingPercent < previous) current.lastDrop = previous - remainingPercent
        else delete current.lastDrop
      }
      current.previous = remainingPercent
    }
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 })
    const rounded = number.format(remainingPercent)
    const nearEndpoint = remainingPercent > 0 && remainingPercent < 100
      && (rounded === number.format(0) || rounded === number.format(100))
    const percent = nearEndpoint
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(remainingPercent)
      : rounded
    const parts = [`${t('staminaTitle')} (${groupName})`, t('staminaRemaining', { percent })]
    if (stale) parts.push(t('staminaStale'))
    else if (accountingPending) parts.push(t('staminaPending'))
    else if (current.lastDrop !== undefined) {
      const drop = new Intl.NumberFormat(locale, { maximumSignificantDigits: 3 }).format(current.lastDrop)
      parts.push(t('staminaLastDrop', { percent: drop }))
    }
    onDescriptionChange(parts.join(' · '))
  }, [accountingPending, groupName, locale, onDescriptionChange, remainingPercent, stale, t])
  return null
}

/** A purple ring surrounds the liquid; the carrier owns focus and semantics. */
export function StaminaLiquid({ remainingPercent, stale }: { remainingPercent: number; stale: boolean }) {
  return (
    <span className={css.frame} data-composer-primary-visual data-verboo-stamina aria-hidden="true">
      <span className={css.ring} data-stamina-ring />
      <span className={css.liquid} data-verboo-stamina-liquid data-stale={stale || undefined}>
        <span
          className={css.water}
          data-stamina-water
          data-surface={remainingPercent > 0 && remainingPercent < 100 || undefined}
          style={{ height: `${remainingPercent}%` }}
        />
      </span>
    </span>
  )
}
