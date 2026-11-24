// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TranscriptViewRow, type TranscriptViewRowProps } from '../src/client/settings/TranscriptViewRow.tsx'
import { PerformanceUsageRow } from '../src/client/settings/PerformanceUsageRow.tsx'
import type { LinkOpening, PerformanceUsageMode } from '../src/chat-settings.ts'
import { LinkOpeningRow } from '../src/client/settings/LinkOpeningRow.tsx'
import { en, zh } from '../src/client/locale.ts'
import type { CollapseTiming, FoldedReplies } from '../src/client/presentation-policy.ts'

afterEach(cleanup)

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }))
}

function noPendingInteraction() {
  return bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map()))
}

// The resource hook the resources plugin merges into GlobalStandardProps; this row reads no address.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

function mount(dictionary: typeof en | typeof zh = en) {
  const collapseTiming = createSnapshotStore<CollapseTiming>('completion')
  const foldedReplies = createSnapshotStore<FoldedReplies>('all')
  const setCollapseTiming = vi.fn((next: CollapseTiming) => { collapseTiming.set(next) })
  const setFoldedReplies = vi.fn((next: FoldedReplies) => { foldedReplies.set(next) })
  const props: TranscriptViewRowProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessions: emptySessions(),
    useSessionStatus: noPendingInteraction(),
    useWorkspaces: emptyWorkspaces(),
    useSessionRetainInfo: () => undefined,
    useResource,
    ...allowAllAccess,
    useContextMenu: contextMenuHook(),
    useCollapseTiming: bindSnapshotSelector(collapseTiming),
    useFoldedReplies: bindSnapshotSelector(foldedReplies),
    setCollapseTiming,
    setFoldedReplies,
    t: makeTranslate(dictionary),
  }
  render(<TranscriptViewRow {...props} />)
  return { setCollapseTiming, setFoldedReplies, collapseTiming, foldedReplies, props }
}

describe('TranscriptViewRow', () => {
  it('offers only the collapse timing and folded-reply choices', () => {
    mount()
    // The work-details presentation is not a preference: this product ships one.
    expect(screen.queryByText('Work details')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.getByText('When to Collapse Work Details')).toBeDefined()
    expect(screen.getByText('Replies After Collapse')).toBeDefined()
  })

  it.each([
    [en, 'When to Collapse Work Details',
      'Choose when to automatically collapse work details', 'On completion', 'On next message'],
    [zh, '工作步骤收起时机', '选择何时自动收起工作步骤', '回答结束后', '下次有新消息时'],
  ] as const)('selects either collapse timing independently with localized labels (%s)', (dictionary, title, description, completion, nextInput) => {
    const b = mount(dictionary)
    expect(screen.getByText(title)).toBeDefined()
    expect(screen.getByText(description)).toBeDefined()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    const trigger = screen.getByRole('button', { name: completion })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([completion, nextInput])
    fireEvent.click(screen.getByRole('menuitem', { name: nextInput }))
    expect(b.setCollapseTiming).toHaveBeenLastCalledWith('next-input')
    expect(b.collapseTiming.getSnapshot()).toBe('next-input')
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: nextInput }))
    fireEvent.click(screen.getByRole('menuitem', { name: completion }))
    expect(b.setCollapseTiming).toHaveBeenLastCalledWith('completion')
    expect(screen.getByRole('button', { name: completion }).getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    [en, 'Replies After Collapse', 'Choose which assistant replies stay visible when work details collapse', 'All replies', 'Final answer only'],
    [zh, '收起后显示的回复', '工作步骤收起后，保留哪些助手回复', '全部回复', '仅最终回答'],
  ] as const)('selects which replies stay visible below collapse timing (%s)', (dictionary, title, description, all, final) => {
    const b = mount(dictionary)
    const timingTitle = dictionary === en ? 'When to Collapse Work Details' : '工作步骤收起时机'
    expect(screen.getByText(timingTitle).compareDocumentPosition(screen.getByText(title)) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(screen.getByText(description)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: all }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([all, final])
    fireEvent.click(screen.getByRole('menuitem', { name: final }))
    expect(b.setFoldedReplies).toHaveBeenLastCalledWith('final')
    expect(b.foldedReplies.getSnapshot()).toBe('final')
    fireEvent.click(screen.getByRole('button', { name: final }))
    fireEvent.click(screen.getByRole('menuitem', { name: all }))
    expect(b.setFoldedReplies).toHaveBeenLastCalledWith('all')
    expect(b.setCollapseTiming).not.toHaveBeenCalled()
  })

  it('follows timing changes and closes its menu without changing either preference', () => {
    const b = mount()
    act(() => { b.collapseTiming.set('next-input') })
    const trigger = screen.getByRole('button', { name: 'On next message' })
    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.setCollapseTiming).not.toHaveBeenCalled()
  })

  it('returns focus before publishing a timing change', async () => {
    const b = mount()
    const trigger = screen.getByRole('button', { name: 'On completion' })
    fireEvent.click(trigger)
    const item = screen.getByRole('menuitem', { name: 'On next message' })
    item.focus()
    const focus = vi.spyOn(trigger, 'focus')
    const publish = b.setCollapseTiming.getMockImplementation()!
    let focusedAtPublication = false
    b.setCollapseTiming.mockImplementation((timing) => {
      focusedAtPublication = document.activeElement === trigger
      publish(timing)
    })
    try {
      await act(async () => { fireEvent.click(item) })
      expect(focusedAtPublication).toBe(true)
      expect(document.activeElement).toBe(trigger)
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      focus.mockRestore()
    }
  })

  it('follows browser availability without clearing the saved destination', () => {
    const b = mount()
    const browserAvailable = createSnapshotStore(false)
    const source = createSnapshotStore<LinkOpening>('new-tab')
    render(<LinkOpeningRow
      {...b.props}
      useLinkOpening={bindSnapshotSelector(source)}
      useBrowserAvailable={bindSnapshotSelector(browserAvailable)}
      setLinkOpening={vi.fn()}
    />)
    expect(screen.queryByText('Open chat links in')).toBeNull()
    act(() => { browserAvailable.set(true) })
    expect(screen.getByRole('button', { name: 'Default Browser' })).toBeDefined()
    act(() => { browserAvailable.set(false) })
    expect(screen.queryByText('Open chat links in')).toBeNull()
    expect(source.getSnapshot()).toBe('new-tab')
  })

  it.each([
    [en, 'Open chat links in', 'Choose where to open web links', 'In-App Sidebar', 'Default Browser'],
    [zh, '网页链接默认打开方式', '对话中网页链接的打开位置', '应用内侧边栏', '默认浏览器'],
  ] as const)('selects either destination using localized labels (%s)', (dictionary, title, description, sidebar, newTab) => {
    const b = mount(dictionary)
    const source = createSnapshotStore<LinkOpening>('sidebar')
    const setLinkOpening = vi.fn((destination: LinkOpening) => { source.set(destination) })
    render(<LinkOpeningRow
      {...b.props}
      useLinkOpening={bindSnapshotSelector(source)}
      useBrowserAvailable={bindSnapshotSelector(createSnapshotStore(true))}
      setLinkOpening={setLinkOpening}
    />)
    expect(screen.getByText(title)).toBeDefined()
    expect(screen.getByText(description)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: sidebar }))
    fireEvent.click(screen.getByRole('menuitem', { name: newTab }))
    expect(setLinkOpening).toHaveBeenLastCalledWith('new-tab')
    fireEvent.click(screen.getByRole('button', { name: newTab }))
    fireEvent.click(screen.getByRole('menuitem', { name: sidebar }))
    expect(setLinkOpening).toHaveBeenLastCalledWith('sidebar')
    expect(screen.getByRole('button', { name: sidebar }).getAttribute('aria-expanded')).toBe('false')
  })
})

describe('PerformanceUsageRow', () => {
  it('selects compact statistics independently of conversation display', () => {
    const b = mount()
    const source = createSnapshotStore<PerformanceUsageMode>('detailed')
    const setPerformanceUsage = vi.fn((mode: PerformanceUsageMode) => { source.set(mode) })
    render(<PerformanceUsageRow
      {...b.props}
      usePerformanceUsage={bindSnapshotSelector(source)}
      setPerformanceUsage={setPerformanceUsage}
    />)
    expect(screen.getByText('Performance & usage')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Detailed' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Compact' }))
    expect(setPerformanceUsage).toHaveBeenCalledWith('compact')
    expect(screen.getAllByRole('button', { name: 'Compact' })).toHaveLength(1)
  })
})
