import { useEffect, useState } from 'react'
import type { HeroProps } from './contracts.ts'
import css from './Product.module.css'
/** A guided task is optional and uses the same draft editor as any conversation. */
export function Hero(props: HeroProps) {
  const { t, observeFirstUse } = props
  const { visible, measurable } = props.useFirstUse(state => state)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (visible && measurable) observeFirstUse()
  }, [visible, measurable, observeFirstUse])

  const prepare = async () => {
    setBusy(true)
    setFailed(false)
    try {
      await props.prepareFirstProject(t('firstUsePrompt'))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return <div className={css.hero}>
    <h1>{t('homeTitle')}</h1>
    {visible && <div className={css.firstUse}>
      <p>{t('firstUseDescription')}</p>
      <div className={css.firstUseActions}>
        <button type="button" className={css.primary} disabled={busy} onClick={() => { void prepare() }}>
          {t('firstUseOpen')}
        </button>
        <button type="button" className={css.secondary} disabled={busy} onClick={props.dismissFirstUse}>
          {t('firstUseLater')}
        </button>
      </div>
      {failed && <p role="status">{t('firstUseFailed')}</p>}
    </div>}
  </div>
}

/** A neutral pulse keeps attention on the answer while it is being prepared. */
export function RunningIndicator() {
  return <span aria-hidden="true" data-verboo-running className={css.runningDot} />
}
