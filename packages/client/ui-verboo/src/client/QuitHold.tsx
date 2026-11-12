/** Native quit gesture; browser tabs retain their own application shortcuts. */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './QuitHold.module.css'

/** Time allowed for the second deliberate shortcut. */
export const QUIT_CONFIRM_MS = 3000
/** The native boundary is supplied by the owned desktop bridge. */
export type QuitHoldProps = PropsLocale<'verboo'> & { quit(this: void): Promise<void>; mac: boolean }

/** Confirm application quit with two distinct shortcut presses. */
export function QuitHold({ quit, mac, t }: QuitHoldProps) {
  const [visible, setVisible] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let armed = false
    let keyHeld = false
    let quitting = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      clearTimeout(deadline)
      armed = false
      keyHeld = false
      setVisible(false)
      setFailed(false)
    }
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { cancel(); return }
      if (event.code !== 'KeyQ' || event.shiftKey || event.altKey || event.isComposing
        || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return
      event.preventDefault()
      if (event.repeat || keyHeld || quitting) return
      keyHeld = true
      if (armed) {
        clearTimeout(deadline)
        armed = false
        quitting = true
        setVisible(false)
        void quit().catch(() => { quitting = false; setFailed(true) })
        return
      }
      setFailed(false)
      armed = true
      setVisible(true)
      deadline = setTimeout(cancel, QUIT_CONFIRM_MS)
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'KeyQ' || event.key === (mac ? 'Meta' : 'Control')) keyHeld = false
    }
    const visibility = () => { if (document.hidden) cancel() }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      clearTimeout(deadline)
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [quit, mac])
  if (!visible && !failed) return null
  return <div className={css.hint} role={failed ? 'alert' : 'status'} data-quit-hold="">
    {t(failed ? 'quitFailed' : 'quitHold', { shortcut: mac ? '⌘Q' : 'Ctrl+Q' })}
  </div>
}

/** Only native windows receive an application-quit capability. */
export function DesktopQuitHold(props: PropsLocale<'verboo'>) {
  const native = globalThis.__VERBOO_DESKTOP__
  return native?.quit === undefined ? null
    : <QuitHold {...props} quit={native.quit} mac={/Mac|iPhone|iPad/.test(navigator.platform)} />
}
