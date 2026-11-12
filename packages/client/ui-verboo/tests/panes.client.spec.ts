// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ISessions,
  SessionBinding,
  SessionListState,
  SessionReference,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { type PanePersistence, PaneController } from '../src/client/panes/controller.ts'
import { leaves, minimumSize, neighbor, readLayout, rectangles } from '../src/client/panes/layout.ts'
import type { PaneLayout, PaneNode } from '../src/client/panes/layout.ts'

const a = 'conversation-a' as SessionId
const b = 'conversation-b' as SessionId
const c = 'conversation-c' as SessionId
const project = 'project' as WorkspaceId
const controllers: PaneController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  localStorage.clear()
})

function fixture(persistence?: PanePersistence, phase: SessionListState['phase'] = 'ready') {
  const list = createSnapshotStore<SessionListState>({
    phase,
    ids: [a, b, c],
    byId: {
      [a]: { id: a, retainedBy: { mainView: 1 } } as SessionSummary,
      [b]: { id: b, retainedBy: {} } as SessionSummary,
      [c]: { id: c, retainedBy: {} } as SessionSummary,
    },
    projectionsBySession: {},
  })
  const released: SessionId[] = []
  const retained: SessionId[] = []
  const create = vi.fn<Pick<ISessions, 'create'>['create']>().mockResolvedValue(c)
  const retain: Pick<ISessions, 'retain'>['retain'] = (target) => {
    if (typeof target !== 'string') throw new Error('fixture expects a direct identity')
    retained.push(target)
    const binding = { sessionId: target } as SessionBinding
    const reference: SessionReference = {
      sessionId: target,
      binding,
      ready: Promise.resolve(binding),
      release: () => {
        released.push(target)
      },
      [Symbol.dispose]() {
        this.release()
      },
    }
    return reference
  }
  const open = vi.fn((id: SessionId) => {
    list.update((s) => {
      for (const summary of Object.values(s.byId))
        s.byId[summary.id] = { ...summary, retainedBy: summary.id === id ? { mainView: 1 } : {} }
    })
  })
  const controller = new PaneController({ list, retain, create }, { open, workspace: () => project }, persistence)
  controllers.push(controller)
  return { controller, list, released, retained, open, create }
}

describe('independent Verboo conversation panes', () => {
  it('closes the last view into a chooser while keeping the workspace open', () => {
    const { controller, released } = fixture()
    const first = controller.focused().id
    controller.close(first)
    const snapshot = controller.state.getSnapshot()
    expect(leaves(snapshot.layout.root)).toHaveLength(1)
    expect(controller.focused()).toMatchObject({ id: first, sessionId: null })
    expect(snapshot.choosing).toBe(first)
    expect(released).toEqual([a])
  })
  it('retains the first conversation and adds an empty chooser without duplicating its editor', () => {
    const { controller, retained, released } = fixture()
    const first = controller.focused()
    expect(first.sessionId).toBe(a)
    controller.split(first.id, 'x')
    const snapshot = controller.state.getSnapshot()
    expect(leaves(snapshot.layout.root).map(p => p.sessionId)).toEqual([a, null])
    expect(snapshot.choosing).toBe(snapshot.layout.focused)
    expect(retained).toEqual([a])
    expect(released).toEqual([])
    controller.select(snapshot.layout.focused, b)
    expect(retained).toEqual([a, b])
    expect(controller.focused().sessionId).toBe(b)
  })

  it('focuses an already visible conversation rather than mounting a second editable root', () => {
    const { controller, retained } = fixture()
    const first = controller.focused().id
    controller.split(first, 'x')
    controller.select(controller.focused().id, b)
    controller.select(first, b)
    expect(leaves(controller.state.getSnapshot().layout.root).map(p => p.sessionId)).toEqual([a, b])
    expect(controller.focused().sessionId).toBe(b)
    expect(retained).toEqual([a, b])
  })

  it('limits nested layouts to four panes and releases only a closed view', () => {
    const { controller, released } = fixture()
    controller.split(controller.focused().id, 'x')
    controller.select(controller.focused().id, b)
    const second = controller.focused().id
    controller.split(second, 'y')
    controller.split(controller.focused().id, 'x')
    controller.split(controller.focused().id, 'y')
    expect(leaves(controller.state.getSnapshot().layout.root)).toHaveLength(4)
    controller.close(second)
    expect(leaves(controller.state.getSnapshot().layout.root)).toHaveLength(3)
    expect(released).toEqual([b])
  })

  it('routes external sidebar navigation to the focused pane and leaves its neighbor retained', () => {
    const { controller, open, released } = fixture()
    const first = controller.focused().id
    controller.split(first, 'x')
    controller.select(controller.focused().id, b)
    open(c)
    expect(leaves(controller.state.getSnapshot().layout.root).map(p => p.sessionId)).toEqual([a, c])
    expect(released).toEqual([b])
    controller.focus(first)
    expect(open).toHaveBeenLastCalledWith(a)
  })

  it('restores pane identities, conversations, focus and divider proportions', () => {
    const { controller } = fixture()
    controller.split(controller.focused().id, 'x')
    controller.select(controller.focused().id, b)
    const root = controller.state.getSnapshot().layout.root
    controller.resize(root.id, 0.63)
    const expected = controller.state.getSnapshot().layout
    const restored = fixture().controller
    expect(restored.state.getSnapshot().layout).toEqual(expected)
    expect(restored.state.getSnapshot().references.size).toBe(2)
  })

  it('waits for the Host layout before opening views and ignores later mirror refreshes', () => {
    const save = vi.fn()
    const { controller, retained } = fixture({ initial: undefined, save })
    expect(controller.state.getSnapshot().restoring).toBe(true)
    expect(retained).toEqual([])
    const root: PaneNode = {
      kind: 'split',
      id: 'saved',
      axis: 'x',
      ratio: 0.62,
      first: { kind: 'pane', id: 'a', sessionId: a },
      second: { kind: 'pane', id: 'b', sessionId: b },
    }
    controller.restore({ version: 1, root, focused: 'b' })
    expect(controller.state.getSnapshot().restoring).toBe(false)
    expect(controller.state.getSnapshot().layout.root).toEqual(root)
    expect(controller.focused().sessionId).toBe(b)
    expect(retained).toEqual([a, b])
    controller.restore(null)
    expect(controller.state.getSnapshot().layout.root).toEqual(root)
  })

  it('defers restored-pane focus retention until the Session catalog is ready', () => {
    const { controller, list, retained } = fixture({ initial: undefined, save: vi.fn() }, 'pending')
    const root: PaneNode = {
      kind: 'split', id: 'saved', axis: 'x', ratio: 0.5,
      first: { kind: 'pane', id: 'a', sessionId: a },
      second: { kind: 'pane', id: 'b', sessionId: b },
    }
    controller.restore({ version: 1, root, focused: 'a' })
    controller.focus('b')
    expect(retained).toEqual([])
    list.update((state) => { state.phase = 'ready' })
    expect(retained).toEqual([a, b])
    expect(controller.focused().sessionId).toBe(b)
    expect(controller.state.getSnapshot().references.size).toBe(2)
  })

  it('does not navigate after a pending new conversation was superseded', async () => {
    const { controller, create } = fixture()
    let finish!: (id: SessionId) => void
    create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    controller.split(controller.focused().id, 'x')
    const pane = controller.focused().id
    const pending = controller.create(pane, project)
    controller.select(pane, b)
    finish(c)
    await pending
    expect(controller.focused().sessionId).toBe(b)
    expect(controller.state.getSnapshot().busy).toBeNull()
  })
})

describe('split layout geometry and persisted input', () => {
  const leaf = (id: string): PaneNode => ({ kind: 'pane', id, sessionId: null })
  const root: PaneNode = {
    kind: 'split',
    id: 'split',
    axis: 'x',
    ratio: 0.5,
    first: leaf('left'),
    second: { kind: 'split', id: 'right', axis: 'y', ratio: 0.5, first: leaf('top'), second: leaf('bottom') },
  }
  const layout: PaneLayout = { version: 1, root, focused: 'left' }
  it('navigates spatially through an asymmetric three-pane layout', () => {
    expect(neighbor(layout, 'right')).toBe('top')
    expect(neighbor({ ...layout, focused: 'top' }, 'down')).toBe('bottom')
    expect(neighbor({ ...layout, focused: 'bottom' }, 'left')).toBe('left')
    expect(neighbor(layout, 'left')).toBe('left')
    expect(neighbor(layout, 'up')).toBe('left')
    expect(rectangles(root).get('bottom')).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 })
    expect(minimumSize(root, 360, 280)).toEqual({ width: 720, height: 560 })
  })
  it('rejects unsupported, duplicate and oversized saved layouts before retaining sessions', () => {
    expect(readLayout(layout)).toEqual(layout)
    expect(readLayout({ ...layout, version: 2 })).toBeNull()
    expect(readLayout({ ...layout, focused: 'missing' })).toBeNull()
    expect(readLayout({ ...layout, root: { ...root, ratio: NaN } })).toBeNull()
    expect(readLayout({ ...layout, root: { ...root, first: leaf('top') } })).toBeNull()
    expect(
      readLayout({
        version: 1,
        focused: 'one',
        root: {
          kind: 'split',
          id: 's',
          axis: 'x',
          ratio: 0.5,
          first: { ...leaf('one'), sessionId: a },
          second: { ...leaf('two'), sessionId: a },
        },
      }),
    ).toBeNull()
  })
})
