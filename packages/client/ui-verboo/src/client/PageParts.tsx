import type { ProductProps } from './contracts.ts'
import { Glyph } from './Glyph.tsx'
import css from './Product.module.css'

/** Product page heading with an optional refresh action. */
export function PageHead({ title, description, t, onRefresh, loading }: {
  title: string
  description: string
  t: ProductProps['t']
  onRefresh?: () => void
  loading?: boolean
}) {
  return (
    <header className={css.pageHead}>
      <div><h1>{title}</h1><p>{description}</p></div>
      {onRefresh && <button className={css.secondary} disabled={loading} onClick={onRefresh}>
        <Glyph name="rotate-cw" size={16} />{t('refresh')}
      </button>}
    </header>
  )
}

/** Account feedback retains its owning action and retry. */
export function Notice({ text, retry, label, error = false }: {
  text: string
  retry?: () => void
  label?: string
  error?: boolean
}) {
  return (
    <div className={css.notice} role={error ? 'alert' : 'status'}>
      <Glyph name="triangle-alert" size={18} />
      <p>{text}</p>
      {retry && <button className={css.textButton} onClick={retry}>{label}</button>}
    </div>
  )
}

/** Announces a pending page read without placeholder account data. */
export function Busy({ label }: { label: string }) {
  return <div className={css.pageLoading} role="status" aria-label={label}>
    <Glyph name="loader-circle" size={24} className={css.spin} />
  </div>
}
