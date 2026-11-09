/** Server-confirmed stamina decorates Send/Stop without controlling submission. */
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
  const model = props.useStaminaModel(state => state.current)
  const resource = props.useResource<'verboo-stamina'>(address)
  const selected = selectStaminaForModel(plans, model, resource.value)
  return <StaminaButtonReading reading={selected.reading} stale={resource.status === 'failed'} />
}

/** Only the selected group's confirmed reading paints the water. */
export function StaminaButtonReading({ reading, stale }: {
  reading: StaminaStatus | undefined
  stale: boolean
}) {
  if (reading === undefined) return null
  return <StaminaLiquid remainingPercent={reading.remainingPercent} stale={stale} />
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
          data-waves={remainingPercent > 0 && remainingPercent < 100 || undefined}
          style={{ height: `${remainingPercent}%` }}
        />
      </span>
    </span>
  )
}
