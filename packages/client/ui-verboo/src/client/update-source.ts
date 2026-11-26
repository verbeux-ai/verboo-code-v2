import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Desktop updater state contains only presentation-safe values. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error'
  readonly percent: number | null
}

/** The native bridge owns verification, installation and lifecycle. */
export interface DesktopUpdateBridge {
  getState(): Promise<DesktopUpdateState>
  subscribe(listener: (state: DesktopUpdateState) => void): () => void
  install(confirmed: boolean): Promise<void>
  retry(): Promise<void>
}

declare global {
  var __VERBOO_UPDATE__: DesktopUpdateBridge | undefined
}

/**
 * Create a source whose snapshot cannot be overwritten by a late initial read.
 * @returns The observable state, subscription lifecycle, and install action.
 */
export function createUpdateSource(): {
  state: ReturnType<typeof createSnapshotStore<DesktopUpdateState>>
  start(): () => void
  install(confirmed: boolean): Promise<void>
  retry(): Promise<void>
} {
  const state = createSnapshotStore<DesktopUpdateState>({ phase: 'idle', percent: null })
  let generation = 0
  let stopCurrent: (() => void) | undefined
  return {
    state,
    start(): () => void {
      stopCurrent?.()
      const bridge = globalThis.__VERBOO_UPDATE__
      if (bridge === undefined) return () => {}
      const activation = ++generation
      let active = true
      let revision = 0
      const unsubscribe = bridge.subscribe((next) => {
        if (active && generation === activation) { revision += 1; state.set(next) }
      })
      const stop = () => {
        if (!active) return
        active = false
        unsubscribe()
        if (generation === activation) { generation += 1; stopCurrent = undefined }
      }
      stopCurrent = stop
      const initialRevision = revision
      void bridge.getState().then((next) => {
        if (active && generation === activation && revision === initialRevision) state.set(next)
      }).catch(() => { /* A missing native response leaves the indicator hidden. */ })
      return stop
    },
    async install(confirmed: boolean): Promise<void> {
      const bridge = globalThis.__VERBOO_UPDATE__
      if (bridge === undefined) throw new Error('desktop update bridge unavailable')
      await bridge.install(confirmed)
    },
    async retry(): Promise<void> {
      const bridge = globalThis.__VERBOO_UPDATE__
      if (bridge === undefined) throw new Error('desktop update bridge unavailable')
      await bridge.retry()
    },
  }
}
