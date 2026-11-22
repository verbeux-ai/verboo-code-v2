import { useEffect, useState } from 'react'

/** How long expanded content stays mounted while the column slides closed. */
export const COLLAPSE_SETTLE_MS = 150

/**
 * A sidebar column collapses as a slide plus crossfade: the expanded content
 * keeps its frozen layout and fades in place while the frame's column slides and
 * clips it, and only after the fade has settled does the compact rail layout
 * apply. Either stage on its own reflows rows mid-slide.
 *
 * The returned flag says whether that settle has happened. It is true while
 * collapsed and settled, and false while expanded or still fading, so a
 * caller renders wide content exactly while the flag is false.
 * @param collapsed - whether the column is closed.
 * @param drawer - whether the closed column is a hidden drawer, which keeps its
 *   content mounted with the rail phase already settled.
 * @returns whether the closed column has finished fading into its rail.
 */
export function useCollapseSettled(collapsed: boolean, drawer: boolean): boolean {
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (drawer || !collapsed) { setSettled(collapsed); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed, drawer])
  return settled
}
