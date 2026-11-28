import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProductProps } from './contracts.ts'
import type { DesktopUpdateState } from './update-source.ts'
import thinkingBoo from './assets/boo-thinking.svg'
import css from './Product.module.css'

/** The native updater indicator and its activity-dependent restart confirmation. */
export function DesktopUpdate({ state, t, install, retry }: {
  state: DesktopUpdateState
  t: ProductProps['t']
  install: (confirmed: boolean) => Promise<void>
  retry: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [failure, setFailure] = useState<'generic' | 'other-instance' | null>(null)
  const [position, setPosition] = useState({ left: 0, bottom: 0, tail: 20 })
  const anchor = useRef<HTMLButtonElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const previous = useRef<DesktopUpdateState['phase']>('idle')
  const visible = state.phase !== 'idle'
  const ready = state.phase === 'ready'
  const failed = state.phase === 'error'
  const label = t(state.phase === 'checking' ? 'updateChecking' : state.phase === 'downloading' ? 'updateDownloading' : ready ? 'updateDownloaded' : state.phase === 'installing' ? 'updateInstalling' : 'updateError')

  useEffect(() => {
    const notify = (state.phase === 'ready' || state.phase === 'error') && previous.current !== state.phase
    previous.current = state.phase
    if (state.phase !== 'ready' && state.phase !== 'error') { setOpen(false); setBusy(false) }
    if (!notify) { setToast(false); return undefined }
    setToast(true)
    const timer = window.setTimeout(() => { setToast(false) }, 3500)
    return () => { window.clearTimeout(timer) }
  }, [state.phase])

  useEffect(() => {
    if (!open && !toast) return
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (rect === undefined) return
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 280))
      setPosition({
        left,
        bottom: Math.max(8, window.innerHeight - rect.top + 10),
        tail: Math.max(14, Math.min(244, rect.left + rect.width / 2 - left)),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open, toast])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (confirm) return
      if (event.target instanceof Node && !anchor.current?.contains(event.target) && !bubble.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (!confirm && event.key === 'Escape') { setOpen(false); anchor.current?.focus() } }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [open, confirm])

  if (!visible) return null
  const percent = state.percent === null ? null : Math.max(0, Math.min(100, state.percent))
  const circle = ready ? 100 : percent ?? 25
  const startInstall = (confirmed: boolean) => {
    setConfirm(false); setBusy(true); setFailure(null)
    void install(confirmed).catch((error: unknown) => {
      const code = typeof error === 'string' ? error : error instanceof Error ? error.message : undefined
      setBusy(false)
      if (code === 'update_confirmation_required') { setConfirm(true); return }
      setFailure(code === 'update_other_instance_active' ? 'other-instance' : 'generic')
    })
  }
  const retryUpdate = () => {
    setBusy(true); setFailure(null)
    void retry().catch(() => { setBusy(false); setFailure('generic') })
  }
  const floating = { left: position.left, bottom: position.bottom, '--update-tail': `${position.tail}px` } as CSSProperties
  return <div className={css.desktopUpdate} data-verboo-update={state.phase} data-indeterminate={(state.phase === 'checking' || state.phase === 'downloading') && percent === null || undefined}>
    <Tooltip portal label={label} disabled={open}>
      <button ref={anchor} type="button" className={css.desktopUpdateButton} aria-label={label}
        aria-haspopup={ready || failed ? 'dialog' : undefined} aria-expanded={ready || failed ? open : undefined}
        aria-disabled={!(ready || failed) || busy} onClick={() => {
          if ((ready || failed) && !busy) { setToast(false); setOpen(!open); setFailure(null) }
        }}>
        <svg viewBox="0 0 36 36" aria-hidden="true">
          {!ready && <><circle className={css.desktopUpdateTrack} cx="18" cy="18" r="15" />
            <circle className={css.desktopUpdateRing} cx="18" cy="18" r="15" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - circle} /></>}
          <path className={css.desktopUpdateArrow} d="M18 10v13m-5-5 5 5 5-5" />
        </svg>
        {ready && <span className={css.desktopUpdateText}>{t('updateCompleteCompact')}</span>}
      </button>
    </Tooltip>
    {toast && !open && createPortal(<div className={css.desktopUpdateToast} style={floating} role={state.phase === 'error' ? 'alert' : 'status'}>{label}</div>, document.body)}
    {open && createPortal(<div ref={bubble} role="dialog" aria-label={label} className={css.desktopUpdateBubble} style={floating}>
      {failed && <img className={css.desktopUpdateMascot} src={thinkingBoo} alt="" />}
      <p>{t(failed ? 'updateErrorDetail' : 'updateReadyMessage')}</p>
      {failure !== null && <p role="alert">{t(failure === 'other-instance' ? 'updateOtherInstance' : 'updateError')}</p>}
      <button type="button" className={css.desktopUpdateRestart} disabled={busy} onClick={() => {
        if (failed) retryUpdate()
        else startInstall(false)
      }}>{t(failed ? 'retry' : 'updateRestart')}</button>
    </div>, document.body)}
    <Modal open={confirm} onClose={() => { setConfirm(false) }} title={t('updateConfirmTitle')}
      description={t('updateConfirmDescription')} closeLabel={t('close')} footer={<>
        <button type="button" className={css.secondary} onClick={() => { setConfirm(false) }}>{t('cancel')}</button>
        <button type="button" className={css.primary} onClick={() => { startInstall(true) }}>{t('updateRestart')}</button>
      </>} />
  </div>
}
