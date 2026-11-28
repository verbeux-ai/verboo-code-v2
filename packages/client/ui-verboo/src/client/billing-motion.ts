import { useLayoutEffect, useRef, useState } from 'react'

/** Duration of the billing panel and dialog transitions, in milliseconds. */
export const billingMotionMs = 200

/**
 * Preserve outgoing content until its exit motion ends. The caller must make it inert immediately.
 * @param current - current content, or null after dismissal.
 * @returns the current content or the last visible snapshot during dismissal.
 */
export function useBillingPresence<T>(current: T | null): T | null {
  const lastVisible = useRef(current)
  const [exited, setExited] = useState(current === null)
  const present = current !== null
  useLayoutEffect(() => {
    if (current !== null) lastVisible.current = current
  }, [current])
  useLayoutEffect(() => {
    if (present) {
      setExited(false)
      return
    }
    if (lastVisible.current === null) return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      lastVisible.current = null
      setExited(true)
      return
    }
    const timeout = window.setTimeout(() => {
      lastVisible.current = null
      setExited(true)
    }, billingMotionMs)
    return () => { window.clearTimeout(timeout) }
  }, [present])
  return current ?? (exited ? null : lastVisible.current)
}
