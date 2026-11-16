/** Running Turn clock isolated from the transcript's render cycle. */
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatRunDuration, LIVE_RUN_CLOCK_INTERVAL_MS } from './message-chrome.ts'
import { RunningWhaleTail } from './RunningWhaleTail.tsx'
import a11yCss from './accessibility.module.css'
import css from './ChatView.module.css'

interface RunningStatusProps {
  readonly startTime: number | undefined
  /** Freeze the shown duration while the Client cannot observe the Session. */
  readonly paused: boolean
  /** Keep the slot without showing or announcing the status: the Session stopped before its Turn closed. */
  readonly holding?: boolean
  /** Changes when the transcript rows before this status change. */
  readonly dividerRevision?: object
  /** Optional product decoration; the clock and accessible status remain owned here. */
  readonly indicator?: ReactNode
  readonly t: ChatViewSlotProps['t']
}

/**
 * Show live elapsed time after the current Turn's content without announcing ticks.
 * @param props - Current Turn start time, pause state, and localized copy.
 * @returns the running indicator; mount while the Session is running, or holding its slot hidden until the
 * Turn's actions row replaces it.
 */
export const RunningStatus = memo(function RunningStatus({
  startTime, paused, holding = false, dividerRevision, indicator, t,
}: RunningStatusProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startTime === undefined || paused || holding) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, LIVE_RUN_CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [startTime, paused, holding])
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    let previous = root.previousElementSibling as HTMLElement | null
    while (previous !== null) {
      const nodeSlot = previous.firstElementChild?.getAttribute('data-slot') === 'conversation.chat.node'
        ? previous.firstElementChild
        : null
      if (previous.hidden || previous.hasAttribute('data-pending-steering') || previous.matches(':empty')
        || previous.hasAttribute('data-chat-flow-empty') || nodeSlot?.childElementCount === 0) {
        previous = previous.previousElementSibling as HTMLElement | null
        continue
      }
      const kind = previous.getAttribute('data-chat-flow-kind')
      const flowItemClass = css.flowItem
      const hasOutput = previous.hasAttribute('data-chat-group-key')
        || (flowItemClass !== undefined && previous.classList.contains(flowItemClass)
          && kind !== 'user' && kind !== 'steering' && kind !== 'turn-trigger')
      if (hasOutput) root.setAttribute('data-chat-divider-visible', '')
      else root.removeAttribute('data-chat-divider-visible')
      return
    }
    root.removeAttribute('data-chat-divider-visible')
  }, [dividerRevision])
  const label = startTime === undefined ? t('chat.deepDiving') : t('chat.deepDivingFor', {
    duration: formatRunDuration(Math.max(1000, now - startTime), t).map(part => part.text).join(''),
  })
  return (
    <div ref={rootRef} className={css.running} data-chat-running
      data-holding={holding ? '' : undefined} aria-hidden={holding || undefined}>
      {holding ? null : (
        <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{t('chat.deepDiving')}</span>
      )}
      <span className={css.runningDivider} aria-hidden="true" />
      <span className={css.runningContent}>
        {indicator ?? <RunningWhaleTail />}
        <TextShimmer active={!holding} className={css.runningText}>{label}</TextShimmer>
      </span>
    </div>
  )
})
