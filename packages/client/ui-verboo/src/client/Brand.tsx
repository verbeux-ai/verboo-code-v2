import mascot from './assets/verboo-mascot.png'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ProductProps } from './contracts.ts'
import css from './Product.module.css'
/** The official app icon and a compact, legible wordmark share one lockup. */
export function Brand({
  t,
  large = false,
}: {
  t: ProductProps['t']
  large?: boolean
}) {
  return (
    <div
      className={css.brand}
      data-large={large || undefined}
      role="img"
      aria-label={t('product')}
    >
      <img
        src={mascot}
        width={large ? 32 : 26}
        height={large ? 32 : 26}
        alt=""
        draggable={false}
      />
      <span className={css.wordmark} aria-hidden="true">
        {t('brand')}
        <span className={css.brandColon}>:</span>
        <span className={css.code}>{t('code')}</span>
      </span>
    </div>
  )
}
/** The official mark on its own, for the collapsed sidebar head. */
export function BrandMark() {
  return (
    <img
      className={css.mark}
      src={mascot}
      width={32}
      height={32}
      alt=""
      draggable={false}
    />
  )
}
/**
 * Mark the Turn's answer once, beside the reply that closes it; every earlier
 * reply row of the same Turn draws nothing.
 * @param props - whether this reply row closes its Turn.
 * @returns the mascot on that row, or `null` so the row reserves no mark column.
 */
export function AssistantMark({ closing }: OwnerOf<'conversation.chat.assistant.mark'>) {
  return closing ? <BrandMark /> : null
}
