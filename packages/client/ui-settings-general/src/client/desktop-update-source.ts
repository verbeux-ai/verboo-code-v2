/** Client-owned observation of the optional native desktop bridge. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopUpdateBridge, DesktopUpdateView } from '../types.ts'

/** Owns one preload subscription across both sidebar locations. */
export class DesktopUpdateSource {
  /** Framework-observed carrier status shared by both sidebar controls. */
  readonly store = createSnapshotStore<DesktopUpdateView>({ failed: false, restarting: false })
  private live = true
  private received = false
  private readonly unsubscribe: (() => void) | undefined

  /** @param bridge - Optional native API, absent in ordinary browsers. */
  constructor(private readonly bridge: DesktopUpdateBridge | undefined) {
    this.unsubscribe = bridge?.subscribe((presentation) => {
      if (!this.live) return
      this.received = true
      this.store.set({ ...this.store.getSnapshot(), presentation, failed: false })
    })
    void bridge?.status().then((presentation) => {
      if (this.live && !this.received) this.store.set({ ...this.store.getSnapshot(), presentation })
    }, () => {
      if (this.live && !this.received) this.store.set({ ...this.store.getSnapshot(), failed: true })
    })
  }

  /** Restart into the staged installer; a second click joins the first. */
  restart(): void {
    if (!this.live || this.bridge === undefined) return
    const state = this.store.getSnapshot()
    if (state.restarting) return
    this.store.set({ ...state, restarting: true })
    void this.bridge.restart().catch(() => {
      if (this.live) this.store.set({ ...this.store.getSnapshot(), failed: true })
    }).finally(() => {
      if (this.live) this.store.set({ ...this.store.getSnapshot(), restarting: false })
    })
  }

  /** Stop offering this version to this reader; the staged copy stays for later. */
  dismiss(): void {
    if (!this.live || this.bridge === undefined) return
    const version = this.store.getSnapshot().presentation?.version
    if (version === undefined) return
    void this.bridge.dismiss(version).catch(() => {})
  }

  /** Detach the carrier and ignore any pending status or action completion. */
  dispose(): void { this.live = false; this.unsubscribe?.() }
}
