/** Server-confirmed stamina sits beside the model without controlling submission. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StaminaStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProductProps } from './contracts.ts'
import { staminaAddress } from './stamina-resource.ts'
import css from './StaminaLiquid.module.css'

/** The toolbar slot places account-owned stamina immediately before the model. */
export function StaminaIndicator(props: PropsRuntime<'conversation.input.right'> & ProductProps) {
  const address = props.useProduct(staminaAddress)
  const resource = props.useResource<'verboo-stamina'>(address)
  return <StaminaIndicatorReading rows={resource.value} stale={resource.status === 'failed'} label={props.t('staminaTitle')} staleLabel={props.t('staminaStale')} />
}

/** The least-full enrolled plan represents the account; unknown enrollment paints no reading. */
export function StaminaIndicatorReading({ rows, stale, label, staleLabel }: {
  rows: StaminaStatus[] | undefined
  stale: boolean
  label: string
  staleLabel: string
}) {
  const reading = rows?.reduce<StaminaStatus | undefined>(
    (lowest, row) => lowest === undefined || row.remainingPercent < lowest.remainingPercent ? row : lowest,
    undefined,
  )
  if (reading === undefined) return null
  return (
    <Tooltip label={stale ? `${label}. ${staleLabel}` : label} side="top" portal openOnClick>
      <span className={css.indicator} data-verboo-stamina role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={reading.remainingPercent} tabIndex={0}>
        <StaminaLiquid remainingPercent={reading.remainingPercent} stale={stale} />
      </span>
    </Tooltip>
  )
}

/** Decorative liquid inside the accessible toolbar meter. */
export function StaminaLiquid({ remainingPercent, stale }: { remainingPercent: number; stale: boolean }) {
  return (
    <span className={css.liquid} data-verboo-stamina-liquid data-stale={stale || undefined} aria-hidden="true">
      <span
        className={css.water}
        data-stamina-water
        data-waves={remainingPercent > 0 && remainingPercent < 100 || undefined}
        style={{ width: `${remainingPercent}%` }}
      />
    </span>
  )
}
