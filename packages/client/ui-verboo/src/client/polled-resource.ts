/**
 * The polling loop two account-owned resources share: poll while the window is
 * visible and online, pause otherwise, abort the in-flight read when the
 * environment or the account identity moves, and resume every mounted view from
 * one shared refresher set.
 *
 * The resources differ only in which address they own and how one Host reply
 * becomes a yield, so both are parameters here.
 *
 * @module
 */

/** One account-owned read the loop performs. */
export interface PolledAccountRead<R, T> {
  /** Cancellation of the whole subscription; the loop ends when it aborts. */
  readonly signal: AbortSignal
  /** Delay after each completed visible-window read. */
  readonly intervalMs: number
  /**
   * Whether the address being served still belongs to the current account.
   * @returns false once an identity change makes this read stale.
   */
  owned(): boolean
  /**
   * Translate one Host reply into yields.
   * @param result - the value the Host call settled with.
   * @returns the values to yield in order.
   */
  interpret(result: R): readonly T[]
  /** What to yield while the window is offline. */
  offline(): T
  /** What to yield when the read itself throws. */
  failed(): T
  /**
   * Subscribe to the account identity.
   * @param onChange - called on every identity change.
   * @returns the unsubscribe handle.
   */
  subscribe(onChange: () => void): () => void
  /** Refresh commands of every mounted view, shared with the caller's own command. */
  readonly refreshers: Set<() => void>
}

/**
 * Run the shared poll loop for one resource address.
 * @param read - the Host method, given a lifetime the loop may abort.
 * @param options - the loop's parameters.
 * @returns the yields the resource provider forwards to its readers.
 */
export async function* pollAccountResource<R, T>(
  read: (signal: AbortSignal) => Promise<R>,
  options: PolledAccountRead<R, T>,
): AsyncGenerator<T> {
  const { signal, intervalMs, refreshers } = options
  const owned = () => options.owned()
  const interpret = (result: R): readonly T[] => options.interpret(result)
  const offline = (): T => options.offline()
  const failed = (): T => options.failed()
  const subscribe = (onChange: () => void): (() => void) => options.subscribe(onChange)
  let pending: AbortController | undefined
  let resume: (() => void) | undefined
  let dirty = false
  const aborted = (): boolean => signal.aborted
  const visible = (): boolean => document.visibilityState === 'visible'
  const online = (): boolean => navigator.onLine
  const notify = (): void => {
    dirty = true
    resume?.()
  }
  const environmentChanged = (): void => {
    if (aborted() || !visible() || !online() || !owned()) pending?.abort()
    notify()
  }
  const identityChanged = (): void => {
    if (!owned()) environmentChanged()
  }
  const wait = async (delay?: number): Promise<void> => {
    if (aborted() || dirty) {
      dirty = false
      return
    }
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (): void => {
        clearTimeout(timer)
        resume = undefined
        dirty = false
        resolve()
      }
      resume = done
      if (delay !== undefined) timer = setTimeout(done, delay)
    })
  }
  const stopAccount = subscribe(identityChanged)
  signal.addEventListener('abort', environmentChanged)
  window.addEventListener('focus', environmentChanged)
  window.addEventListener('online', environmentChanged)
  window.addEventListener('offline', environmentChanged)
  document.addEventListener('visibilitychange', environmentChanged)
  refreshers.add(notify)
  try {
    while (!aborted() && owned()) {
      if (!visible()) {
        await wait()
        continue
      }
      if (!online()) {
        yield offline()
        await wait()
        continue
      }
      dirty = false
      pending = new AbortController()
      try {
        const result = await read(AbortSignal.any([signal, pending.signal]))
        if (aborted() || !owned()) return
        if (!visible() || !online()) continue
        for (const value of interpret(result)) yield value
      } catch (_error) {
        if (aborted() || !owned()) return
        if (!visible() || !online()) continue
        yield failed()
      } finally {
        pending = undefined
      }
      await wait(intervalMs)
    }
  } finally {
    pending?.abort()
    refreshers.delete(notify)
    stopAccount()
    signal.removeEventListener('abort', environmentChanged)
    window.removeEventListener('focus', environmentChanged)
    window.removeEventListener('online', environmentChanged)
    window.removeEventListener('offline', environmentChanged)
    document.removeEventListener('visibilitychange', environmentChanged)
    resume?.()
  }
}
