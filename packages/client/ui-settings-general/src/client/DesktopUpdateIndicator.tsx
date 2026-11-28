/** Desktop update affordance for the product sidebar footer. */
import { useState } from 'react'
import { IconDownloadOutlineRegular, IconLoadingOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DesktopUpdateIndicator.module.css'
import type { DesktopUpdatePresentation, DesktopUpdateView } from '../types.ts'

/** Registrant-private face for the footer row. */
export interface DesktopUpdateIndicatorInjected {
  hooks: {
    /** Shared carrier status owned by the plugin's one subscription. */
    desktopUpdate: HostObservable<DesktopUpdateView>
  }
  /** Restart into the staged installer. */
  restartDesktopUpdate: () => void
  /** Stop offering this version to this reader. */
  dismissDesktopUpdate: () => void
}

/** Full footer-row props. */
export type DesktopUpdateIndicatorProps =
  PropsRuntime<'sidebar.footer.row'>
  & PropsLocale<'settings'>
  & InjectFace<DesktopUpdateIndicatorInjected>

/** Phases that keep the row busy and unclickable. */
const BUSY_PHASES: ReadonlySet<DesktopUpdatePresentation['phase']> = new Set(['checking', 'downloading'])

/**
 * Render the update row above the plan shortcut, and confirm one restart.
 *
 * The native side downloads on its own, so this row only reports: progress while
 * it runs, a quiet affordance once the installer is staged, and a diagnostic
 * label on failure. Nothing opens a window; confirming restarts in place.
 * @param props - Localized copy, the shared carrier status, and the two actions.
 * @returns the row, or nothing in browsers or when there is nothing to say.
 */
export function DesktopUpdateIndicator({
  t, wide, useDesktopUpdate, restartDesktopUpdate, dismissDesktopUpdate,
}: DesktopUpdateIndicatorProps) {
  const [confirming, setConfirming] = useState(false)
  const view = useDesktopUpdate(value => value)
  const { presentation: state, failed, restarting } = view
  const idle = state === undefined
    || (state.phase === 'idle' && state.configurationError === undefined)
  if (!failed && idle) return null
  const error = failed || state?.phase === 'error' || state?.configurationError !== undefined
  const busy = restarting || (state !== undefined && BUSY_PHASES.has(state.phase))
  const staged = !error && state?.phase === 'ready'
  const label = error
    ? t('desktop.update.retry')
    : state?.phase === 'downloading'
      ? t('desktop.update.progress', { percent: state.percent ?? 0 })
      : t('desktop.update.ready')
  const detail = error
    ? t('desktop.update.failedDetail')
    : staged
      ? t('desktop.update.readyDetail', { version: state.version ?? '' })
      : t('desktop.update.downloadingDetail')
  return (
    <>
      <Tooltip portal label={detail} disabled={wide}>
        <button
          type="button"
          className={css.indicator}
          data-staged={staged || undefined}
          aria-label={staged ? `${label}. ${detail}` : label}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) return
            if (staged) { setConfirming(true); return }
            if (error) dismissDesktopUpdate()
          }}
        >
          <span className={css.icon} aria-hidden="true">
            {error || staged
              ? <IconDownloadOutlineRegular size={14} />
              : <IconLoadingOutlineRegular className={css.spinner} size={14} />}
          </span>
          {wide && <span className={css.label}>{label}</span>}
        </button>
      </Tooltip>
      <Modal
        open={confirming}
        title={t('desktop.update.confirmTitle')}
        closeLabel={t('desktop.update.confirmLater')}
        onClose={() => { setConfirming(false) }}
        footer={
          <>
            <button type="button" className={css.secondary} onClick={() => { setConfirming(false) }}>
              {t('desktop.update.confirmLater')}
            </button>
            <button
              type="button"
              className={css.primary}
              onClick={() => { setConfirming(false); restartDesktopUpdate() }}
            >
              {t('desktop.update.confirmRestart')}
            </button>
          </>
        }
      >
        <p className={css.confirmBody}>
          {t('desktop.update.confirmBody', { version: state?.version ?? '' })}
        </p>
      </Modal>
    </>
  )
}
