import type { ReactNode } from 'react'
import thinkingBoo from './assets/boo-thinking.svg'
import sadBoo from './assets/boo-sad.svg'
import type { ProductError } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ProductProps } from './contracts.ts'
import { Glyph } from './Glyph.tsx'
import css from './Product.module.css'

/** Product page heading with optional page-level actions beside refresh. */
export function PageHead({ title, description, t, onRefresh, onClose, loading, actions }: {
  title: string
  description: string
  t: ProductProps['t']
  onRefresh?: () => void
  onClose?: () => void
  loading?: boolean
  /** Page-level actions, placed left of refresh in the heading's trailing group. */
  actions?: ReactNode
}) {
  return (
    <header className={css.pageHead}>
      <div><h1>{title}</h1><p>{description}</p></div>
      <div className={css.pageActions}>
        {actions}
        {onRefresh && <button className={css.secondary} disabled={loading} onClick={onRefresh}>
          <Glyph name="rotate-cw" size={16} />{t('refresh')}
        </button>}
        {onClose && <button type="button" className={css.iconButton} aria-label={t('close')} onClick={onClose}>
          <Glyph name="x" size={18} />
        </button>}
      </div>
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
    <div className={error ? css.noticeError : css.notice} role={error ? 'alert' : 'status'}>
      {error ? <div className={css.noticeMascot} aria-hidden="true"><img src={thinkingBoo} alt="" /></div> : <Glyph name="triangle-alert" size={18} />}
      <div className={error ? css.noticeCard : css.noticeBody}>
        <p>{text}</p>
        {retry && <button className={css.textButton} onClick={retry}>{label}</button>}
      </div>
    </div>
  )
}

/** Present safe read failures while leaving previously loaded content visible. */
export function ReadFailure({ kind, reason, hasPrevious, retry, signIn, t }: {
  kind: 'plans' | 'connections'
  reason: ProductError | 'unexpected' | undefined
  hasPrevious: boolean
  retry: () => void
  signIn: () => void
  t: ProductProps['t']
}) {
  const signedOut = reason === 'signed_out'
  const title = signedOut ? t('readAuthTitle') : kind === 'plans' ? t('readPlansTitle') : t('readConnectionsTitle')
  const description = signedOut ? t('readAuthDescription') : reason === 'account_changed' ? t('readInterrupted') : t('readRetryDescription')
  return <div className={css.readFailure} role="alert">
    <img src={signedOut ? sadBoo : thinkingBoo} alt="" />
    <div>
      <strong>{title}</strong>
      <p>{description}</p>
      {hasPrevious && <p>{t('readStale')}</p>}
      <div className={css.readFailureActions}>
        {signedOut && <button type="button" className={css.primary} onClick={signIn}>{t('readSignIn')}</button>}
        <button type="button" className={signedOut ? css.textButton : css.primary} onClick={retry}>{t('retry')}</button>
      </div>
    </div>
  </div>
}

/** Announces a pending page read without placeholder account data. */
export function Busy({ label }: { label: string }) {
  return <div className={css.pageLoading} role="status" aria-label={label}>
    <Glyph name="loader-circle" size={24} className={css.spin} />
  </div>
}
