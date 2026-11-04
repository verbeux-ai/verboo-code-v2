import mascot from './assets/verboo-mascot.png'
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
      aria-label={t('product')}
    >
      <img
        src={mascot}
        width={large ? 30 : 24}
        height={large ? 30 : 24}
        alt=""
        draggable={false}
      />
      <span className={css.wordmark}>
        {t('brand')}
        <span className={css.code}>{t('code')}</span>
      </span>
    </div>
  )
}
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
