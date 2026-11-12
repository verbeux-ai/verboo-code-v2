/** Own pane selections and explicit Session references without owning Agent execution. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { leaves, mapNode, MAX_PANES, neighbor, readLayout, removePane } from './layout.ts'
import type { PaneAxis, PaneLayout, PaneLeaf } from './layout.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    verbooPane: unknown
  }
}

/** Render facts, separated from high-frequency conversation state. */
export interface PaneSnapshot {
  layout: PaneLayout
  restoring: boolean
  references: ReadonlyMap<string, SessionReference>
  choosing: string | null
  busy: string | null
  failure: string | null
  focusRequest: { pane: string; sequence: number } | null
}
/** Product navigation callbacks using the existing Workspace service. */
export interface PaneNavigation {
  open(id: SessionId): void
  workspace(id: SessionId): WorkspaceId | undefined
}
/** Profile-backed persistence supplied by the existing settings service. */
export interface PanePersistence {
  initial: unknown
  save(layout: PaneLayout): void
}
/** One controller per product composition; unloading releases views, never stops agents. */
export class PaneController {
  /** Current pane layout and navigation state. */
  readonly state
  private readonly saved
  private readonly references = new Map<string, SessionReference>()
  private readonly off: () => void
  private syncing = false
  private started = false
  private disposed = false
  private lastMain: SessionId | undefined
  private request = 0

  /** @param sessions - existing Session Controller.
   * @param navigation - existing Workspace navigation.
   * @param persistence - Host-backed layout; omitted uses local storage for standalone clients. */
  constructor(
    private readonly sessions: Pick<ISessions, 'list' | 'retain' | 'create'>,
    private readonly navigation: PaneNavigation,
    private readonly persistence?: PanePersistence,
  ) {
    const initial: PaneLayout = {
      version: 1,
      root: { kind: 'pane', id: randomUUID(), sessionId: null },
      focused: '',
    }
    initial.focused = initial.root.id
    this.saved = createSnapshotStore<unknown>(
      persistence === undefined ? initial : persistence.initial,
      persistence === undefined ? { persist: { name: 'verboo.chat-panes.v1' } } : undefined,
    )
    const layout = readLayout(this.saved.getSnapshot()) ?? initial
    this.state = createSnapshotStore<PaneSnapshot>({
      layout,
      restoring: persistence !== undefined && persistence.initial === undefined,
      references: new Map(),
      choosing: null,
      busy: null,
      failure: null,
      focusRequest: null,
    })
    this.off = sessions.list.subscribe(() => {
      this.sync()
    })
    this.sync()
  }

  /** Adopt the authoritative Host setting before mounting saved conversation views.
   * @param value - parsed Host document, or null for a new arrangement.
   */
  restore(value: unknown): void {
    if (!this.state.getSnapshot().restoring) return
    const layout = readLayout(value) ?? this.state.getSnapshot().layout
    this.state.update((s) => {
      s.layout = layout
      s.restoring = false
    })
    this.sync()
  }

  /** Release Client view references only. */
  dispose(): void {
    this.disposed = true
    this.request++
    this.off()
    for (const reference of this.references.values()) reference.release()
    this.references.clear()
  }

  /** Current focused leaf.
   * @returns the leaf owning keyboard navigation. */
  focused(): PaneLeaf {
    const { layout } = this.state.getSnapshot()
    const pane = leaves(layout.root).find(p => p.id === layout.focused)
    if (pane === undefined) throw new Error('Pane layout has no focused leaf')
    return pane
  }

  /** Focus one visible pane and synchronize existing global navigation.
   * @param id - pane identity. */
  focus(id: string): void {
    const snapshot = this.state.getSnapshot()
    const pane = leaves(snapshot.layout.root).find(p => p.id === id)
    if (pane === undefined) return
    if (snapshot.layout.focused !== id) this.commit({ ...snapshot.layout, focused: id })
    if (pane.sessionId !== null && this.references.has(id) && pane.sessionId !== this.lastMain)
      this.navigation.open(pane.sessionId)
  }

  /** Navigate by geometric direction.
   * @param direction - requested neighbor. */
  move(direction: 'left' | 'right' | 'up' | 'down'): void {
    const target = neighbor(this.state.getSnapshot().layout, direction)
    this.focus(target)
    this.state.update((s) => {
      s.focusRequest = { pane: target, sequence: (s.focusRequest?.sequence ?? 0) + 1 }
    })
  }

  /** Restore keyboard focus without changing the saved spatial arrangement.
   * @param id - visible pane. */
  focusInput(id: string): void {
    this.focus(id)
    this.state.update((s) => {
      s.focusRequest = { pane: id, sequence: (s.focusRequest?.sequence ?? 0) + 1 }
    })
  }

  /** Split a leaf, leaving its conversation mounted and focusing an empty selector.
   * @param id - pane.
   * @param axis - divider orientation. */
  split(id: string, axis: PaneAxis): void {
    const { layout } = this.state.getSnapshot()
    if (leaves(layout.root).length >= MAX_PANES) return
    const pane = leaves(layout.root).find(p => p.id === id)
    if (pane === undefined) return
    const workspaceId = pane.workspaceId ?? (pane.sessionId === null ? undefined : this.navigation.workspace(pane.sessionId))
    const next: PaneLeaf = {
      kind: 'pane',
      id: randomUUID(),
      sessionId: null,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }
    this.commit({
      ...layout,
      focused: next.id,
      root: mapNode(layout.root, id, node => ({
        kind: 'split',
        id: randomUUID(),
        axis,
        ratio: 0.5,
        first: node,
        second: next,
      })),
    })
    this.choose(next.id)
  }

  /** Close a view without stopping or deleting its conversation.
   * @param id - pane identity. */
  close(id: string): void {
    const snapshot = this.state.getSnapshot()
    const root = removePane(snapshot.layout.root, id)
    if (root === null) {
      this.request++
      this.commit({ ...snapshot.layout, root: { ...this.focused(), sessionId: null } })
      this.choose(id)
      this.focusInput(id)
      return
    }
    if (leaves(snapshot.layout.root).length === leaves(root).length) return
    this.request++
    const first = leaves(root)[0]
    if (first === undefined) throw new Error('Pane layout has no surviving leaf')
    const focused = snapshot.layout.focused === id ? first.id : snapshot.layout.focused
    this.commit({ ...snapshot.layout, root, focused })
    this.state.update((s) => {
      s.choosing = null
      s.busy = null
      s.failure = null
    })
    this.focus(focused)
    this.focusInput(focused)
  }

  /** Persist a constrained divider ratio.
   * @param id - split identity.
   * @param ratio - validated geometry.
   * @param persist - whether to save the new ratio. */
  resize(id: string, ratio: number, persist = true): void {
    const { layout } = this.state.getSnapshot()
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return
    this.commit(
      { ...layout, root: mapNode(layout.root, id, node => (node.kind === 'split' ? { ...node, ratio } : node)) },
      persist,
    )
  }

  /** Persist the final pointer geometry once a resize ends. */
  save(): void {
    this.persistence?.save(this.state.getSnapshot().layout)
  }

  /** Open or dismiss one pane's conversation selector.
   * @param id - target pane, or null to dismiss. */
  choose(id: string | null): void {
    this.request++
    this.state.update((s) => {
      s.choosing = id
      s.busy = null
      s.failure = null
    })
  }

  /** Select an existing conversation, focusing its existing pane when already visible.
   * @param id - target pane.
   * @param sessionId - chosen conversation. */
  select(id: string, sessionId: SessionId): void {
    const { layout } = this.state.getSnapshot()
    if (!leaves(layout.root).some(p => p.id === id)) return
    const existing = leaves(layout.root).find(p => p.sessionId === sessionId)
    this.choose(null)
    if (existing !== undefined) {
      this.focus(existing.id)
      return
    }
    this.commit({
      ...layout,
      focused: id,
      root: mapNode(layout.root, id, node =>
        node.kind === 'pane' ? { ...node, sessionId, workspaceId: this.navigation.workspace(sessionId) } : node,
      ),
    })
    this.focus(id)
  }

  /** Create a distinct blank through the existing Controller; superseded choices never replace another pane.
   * @param id - target pane.
   * @param workspaceId - selected project.
   * @returns completion. */
  async create(id: string, workspaceId: WorkspaceId): Promise<void> {
    const attempt = ++this.request
    this.state.update((s) => {
      s.busy = id
      s.failure = null
    })
    try {
      const sessionId = await this.sessions.create({ workspaceId })
      if (
        this.disposed ||
        attempt !== this.request ||
        !leaves(this.state.getSnapshot().layout.root).some(p => p.id === id)
      )
        return
      this.select(id, sessionId)
    } catch (_error) {
      if (!this.disposed && attempt === this.request)
        this.state.update((s) => {
          s.failure = id
        })
    } finally {
      if (!this.disposed && attempt === this.request)
        this.state.update((s) => {
          s.busy = null
        })
    }
  }

  private commit(layout: PaneLayout, persist = true): void {
    this.state.update((s) => {
      s.layout = layout
    })
    this.saved.set(layout)
    if (persist) this.persistence?.save(layout)
    this.retain()
  }

  private retain(): void {
    // Restored selectors can receive focus before the Session catalog arrives.
    // The ready catalog's sync owns the first retain and stale-id cleanup.
    if (this.sessions.list.getSnapshot().phase !== 'ready') return
    const panes = leaves(this.state.getSnapshot().layout.root)
    for (const [id, reference] of this.references) {
      if (!panes.some(p => p.id === id && p.sessionId === reference.sessionId)) {
        this.references.delete(id)
        reference.release()
      }
    }
    for (const pane of panes) {
      if (pane.sessionId === null || this.references.has(pane.id)) continue
      const reference = this.sessions.retain(pane.sessionId, { source: 'verbooPane' })
      this.references.set(pane.id, reference)
      void reference.ready.catch((error: unknown) => {
        if (!this.disposed && this.references.get(pane.id) === reference)
          console.error('Verboo pane: conversation could not open', error)
      })
    }
    this.state.update((s) => {
      s.references = new Map(this.references)
    })
  }

  private sync(): void {
    if (this.disposed || this.syncing || this.state.getSnapshot().restoring) return
    this.syncing = true
    try {
      const catalog = this.sessions.list.getSnapshot()
      if (catalog.phase !== 'ready') return
      const main = catalog.ids.find(id => (catalog.byId[id]?.retainedBy.mainView ?? 0) > 0)
      if (!this.started) {
        this.started = true
        const { layout } = this.state.getSnapshot()
        let root = layout.root
        for (const pane of leaves(root)) {
          if (pane.sessionId !== null && catalog.byId[pane.sessionId] === undefined)
            root = mapNode(root, pane.id, node => (node.kind === 'pane' ? { ...node, sessionId: null } : node))
        }
        this.commit({ ...layout, root })
        const focused = this.focused()
        if (focused.sessionId !== null) {
          this.lastMain = focused.sessionId
          this.navigation.open(focused.sessionId)
          return
        }
      }
      if (main === undefined || main === this.lastMain) return
      this.lastMain = main
      const { layout } = this.state.getSnapshot()
      const existing = leaves(layout.root).find(p => p.sessionId === main)
      this.commit({
        ...layout,
        focused: existing?.id ?? layout.focused,
        root:
          existing === undefined
            ? mapNode(layout.root, layout.focused, node =>
              node.kind === 'pane'
                ? { ...node, sessionId: main, workspaceId: this.navigation.workspace(main) }
                : node,
            )
            : layout.root,
      })
      this.choose(null)
    } finally {
      this.syncing = false
    }
  }
}
