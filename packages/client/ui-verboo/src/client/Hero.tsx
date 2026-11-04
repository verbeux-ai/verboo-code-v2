import type { HeroProps } from './contracts.ts'
import css from './Product.module.css'
/** One quiet opening question leaves the conversation and composer in focus. */
export function Hero({ t }: HeroProps) {
  return <div className={css.hero}><h1>{t('homeTitle')}</h1></div>
}

/** A neutral pulse keeps attention on the answer while it is being prepared. */
export function RunningIndicator() {
  return <span aria-hidden="true" data-verboo-running className={css.runningDot} />
}
