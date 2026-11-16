import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Optional visibility operation; its caller owns cancellation and eventually commits the attribute.
 * @param element - stable subtree root.
 * @param hidden - desired hidden state.
 * @param commit - apply the final visibility before reporting the operation complete.
 */
export type HiddenTransition = (element: HTMLElement, hidden: boolean, commit: () => void) => void

/**
 * Apply searchable hidden state without unmounting a stable subtree.
 * @param hidden - whether the subtree is currently hidden.
 * @param reveal - callback for browser find's beforematch reveal.
 * @param transition - optional caller-owned visibility operation; otherwise apply synchronously.
 * @returns ref for the stable subtree root; a `beforematch` listener exists only while the subtree is hidden.
 */
export function useSearchableHidden(
  hidden: boolean,
  reveal: () => void,
  transition?: HiddenTransition,
): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  // Native find only targets until-found content; visible rows need no listener.
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (hidden && element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return
    }
    const commit = (): void => {
      if (hidden) element.setAttribute('hidden', 'until-found')
      else element.removeAttribute('hidden')
    }
    if (transition === undefined) commit()
    else transition(element, hidden, commit)
  }, [hidden, reveal, transition])
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null || !hidden) return
    element.addEventListener('beforematch', reveal)
    return () => { element.removeEventListener('beforematch', reveal) }
  }, [hidden, reveal])
  return ref
}
