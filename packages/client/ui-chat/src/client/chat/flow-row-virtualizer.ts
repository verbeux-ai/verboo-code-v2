/** Keep stable transcript shells while replacing distant settled Assistant bodies with searchable text. */

export interface FlowRowVirtualizationState {
  readonly suspended: boolean
  /** Last measured row height used to hold its scroll position while content is suspended. */
  readonly height: number | null
}

interface FlowRowRecord {
  readonly key: string
  element: HTMLElement | null
  eligible: boolean
  offscreen: boolean
  height: number | null
  state: FlowRowVirtualizationState
  readonly listeners: Set<() => void>
}

const ACTIVE: FlowRowVirtualizationState = Object.freeze({ suspended: false, height: null })
const ROOT_MARGIN = '1200px 0px'
const PROTECTED_DESCENDANTS = 'details[open], [aria-expanded="true"], [data-chat-virtualization-pin]'

/** One observer pair per Chat flow; row roots and semantic anchors remain mounted. */
export class FlowRowVirtualizer {
  private readonly rows = new Map<string, FlowRowRecord>()
  private readonly keyByElement = new WeakMap<Element, string>()
  private selectionProtectedKeys = new Set<string>()
  private intersection: IntersectionObserver | null = null
  private resize: ResizeObserver | null = null
  private eventRoot: HTMLElement | null = null
  private selectionListener: (() => void) | null = null
  private disposed = false

  /** Read the current virtualization state for one transcript row.
   * @param key - stable Chat row identity.
   * @returns the current immutable row state, or the active state when the row is not registered.
   */
  getSnapshot(key: string): FlowRowVirtualizationState {
    return this.rows.get(key)?.state ?? ACTIVE
  }

  /** Subscribe to state changes for one transcript row.
   * @param key - stable Chat row identity.
   * @param listener - callback invoked after that row's state changes.
   * @returns a function that removes the listener.
   */
  subscribe(key: string, listener: () => void): () => void {
    const row = this.rows.get(key)
    if (row === undefined) return () => {}
    row.listeners.add(listener)
    return () => { row.listeners.delete(listener) }
  }

  /** Observe a settled eligible row; an ineligible update restores its full content immediately.
   * @param key - stable Chat row identity.
   * @param element - mounted row element, or `null` after its element changes or unmounts.
   * @param eligible - whether this settled Assistant row may suspend while offscreen.
   */
  register(key: string, element: HTMLElement | null, eligible: boolean): void {
    if (this.disposed) return
    let row = this.rows.get(key)
    if (row === undefined) {
      if (!eligible) return
      row = { key, element: null, eligible, offscreen: false, height: null, state: ACTIVE, listeners: new Set() }
      this.rows.set(key, row)
    }

    if (row.element !== element) {
      if (row.element !== null) {
        this.intersection?.unobserve(row.element)
        this.resize?.unobserve(row.element)
        this.keyByElement.delete(row.element)
      }
      row.element = element
      row.offscreen = false
    }
    row.eligible = eligible
    if (element === null) {
      this.setState(row, ACTIVE)
      return
    }

    this.keyByElement.set(element, key)
    if (eligible) {
      this.ensureObservers(element)
      this.intersection?.observe(element)
      this.resize?.observe(element)
    } else {
      this.intersection?.unobserve(element)
      this.resize?.unobserve(element)
      this.setState(row, ACTIVE)
    }
  }

  /** Drop one row after its keyed React seat unmounts.
   * @param key - stable Chat row identity.
   */
  unregister(key: string): void {
    const row = this.rows.get(key)
    if (row === undefined) return
    this.register(key, null, false)
    this.rows.delete(key)
    this.selectionProtectedKeys.delete(key)
  }

  /** Release DOM observers and listeners when the owning Chat flow unmounts. */
  dispose(): void {
    this.disposed = true
    this.intersection?.disconnect()
    this.resize?.disconnect()
    this.eventRoot?.removeEventListener('pointerout', this.onDelegatedInteractionOut)
    this.eventRoot?.removeEventListener('focusout', this.onDelegatedInteractionOut)
    if (this.selectionListener !== null) document.removeEventListener('selectionchange', this.selectionListener)
    this.intersection = null
    this.resize = null
    this.eventRoot = null
    this.selectionListener = null
    this.rows.clear()
    this.selectionProtectedKeys.clear()
  }

  private ensureObservers(firstElement: HTMLElement): void {
    if (this.intersection !== null || typeof IntersectionObserver === 'undefined') return
    const root = firstElement.closest<HTMLElement>('[data-conversation-scroll]')
      ?? firstElement.closest<HTMLElement>('[data-chat-flow]')?.parentElement
      ?? null
    this.eventRoot = root ?? firstElement.parentElement
    this.eventRoot?.addEventListener('pointerout', this.onDelegatedInteractionOut)
    this.eventRoot?.addEventListener('focusout', this.onDelegatedInteractionOut)
    this.intersection = new IntersectionObserver(this.onIntersection, { root, rootMargin: ROOT_MARGIN })
    if (typeof ResizeObserver !== 'undefined') this.resize = new ResizeObserver(this.onResize)
    this.selectionListener = this.onSelectionChange
    document.addEventListener('selectionchange', this.selectionListener)
  }

  private readonly onIntersection = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      const key = this.keyByElement.get(entry.target)
      const row = key === undefined ? undefined : this.rows.get(key)
      if (row === undefined || row.element === null || !row.eligible) continue
      row.offscreen = !entry.isIntersecting
      if (!row.offscreen) {
        // Keep a native text selection stable when its plain text proxy enters
        // the viewport. selectionchange restores the rich body after release.
        if (row.state.suspended && this.selected(row.element)) {
          this.selectionProtectedKeys.add(row.key)
          continue
        }
        this.setState(row, ACTIVE)
        continue
      }
      this.suspendIfSafe(row)
    }
  }

  private readonly onResize = (entries: ResizeObserverEntry[]): void => {
    for (const entry of entries) {
      const key = this.keyByElement.get(entry.target)
      const row = key === undefined ? undefined : this.rows.get(key)
      if (row === undefined || row.element === null || row.state.suspended) continue
      const height = row.element.getBoundingClientRect().height
      if (Number.isFinite(height) && height > 0) row.height = height
    }
  }

  private readonly onDelegatedInteractionOut = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const element = target.closest<HTMLElement>('[data-chat-flow-key]')
    if (element === null) return
    const relatedTarget = event instanceof FocusEvent || event instanceof PointerEvent ? event.relatedTarget : null
    if (relatedTarget instanceof Node && element.contains(relatedTarget)) return
    const key = this.keyByElement.get(element)
    const row = key === undefined ? undefined : this.rows.get(key)
    if (row !== undefined) this.reconcile(row)
  }

  private readonly onSelectionChange = (): void => {
    const selection = document.getSelection()
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      this.releaseSelectionProtection()
      return
    }
    const endpointKey = (node: Node | null): string | undefined => {
      const element = node instanceof Element ? node : node?.parentElement
      const rowElement = element?.closest<HTMLElement>('[data-chat-flow-key]')
      return rowElement === null || rowElement === undefined ? undefined : this.keyByElement.get(rowElement)
    }
    if (endpointKey(selection.anchorNode) === undefined && endpointKey(selection.focusNode) === undefined) {
      this.releaseSelectionProtection()
      return
    }

    const range = selection.getRangeAt(0)
    const nextKeys = new Set<string>()
    for (const row of this.rows.values()) {
      if (row.element !== null && row.element.isConnected && range.intersectsNode(row.element)) {
        nextKeys.add(row.key)
      }
    }
    for (const key of this.selectionProtectedKeys) {
      if (nextKeys.has(key)) continue
      const row = this.rows.get(key)
      if (row !== undefined) this.reconcile(row)
    }
    this.selectionProtectedKeys = nextKeys
  }

  private releaseSelectionProtection(): void {
    for (const key of this.selectionProtectedKeys) {
      const row = this.rows.get(key)
      if (row !== undefined) this.reconcile(row)
    }
    this.selectionProtectedKeys.clear()
  }

  private reconcile(row: FlowRowRecord): void {
    const element = row.element
    if (!row.eligible || element === null || !element.isConnected) return
    if (row.offscreen) {
      this.suspendIfSafe(row)
    } else if (row.state.suspended && !this.selected(element)) {
      this.setState(row, ACTIVE)
    }
  }

  private suspendIfSafe(row: FlowRowRecord): void {
    const element = row.element
    if (!row.eligible || element === null || !element.isConnected) return
    if (this.protected(element)) {
      this.setState(row, ACTIVE)
      return
    }
    const height = row.height ?? element.getBoundingClientRect().height
    this.setState(row, Object.freeze({ suspended: true, height: height > 0 ? height : null }))
  }

  private protected(element: HTMLElement): boolean {
    if (element.matches(':hover') || element.querySelector(PROTECTED_DESCENDANTS) !== null) return true
    if (document.activeElement !== null && element.contains(document.activeElement)) return true
    return this.selected(element)
  }

  private selected(element: HTMLElement): boolean {
    const selection = document.getSelection()
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return false
    return selection.getRangeAt(0).intersectsNode(element)
  }

  private setState(row: FlowRowRecord, state: FlowRowVirtualizationState): void {
    if (row.state.suspended === state.suspended
      && (!state.suspended || row.state.height === state.height)) return
    row.state = state
    for (const listener of row.listeners) listener()
  }
}
