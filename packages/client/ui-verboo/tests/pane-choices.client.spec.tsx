// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Choices, type ChoicesProps } from '../src/client/panes/Panes.tsx'
import type { PaneSnapshot } from '../src/client/panes/controller.ts'
import { pt } from '../src/client/locales.ts'

afterEach(cleanup)
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }))
afterAll(() => {
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})
const project = 'suri' as WorkspaceId
const other = 'other' as WorkspaceId
const a = 'a' as SessionId
const b = 'b' as SessionId
const c = 'c' as SessionId

function fixture() {
  const summary = (id: SessionId, displayTitle: string, updatedAt: number): SessionSummary => ({
    id, displayTitle, updatedAt, blank: false, running: false, retainedBy: {},
  })
  const catalog: SessionListState = {
    ids: [a, b, c], phase: 'ready', projectionsBySession: {},
    byId: { [a]: summary(a, 'Integração', 1), [b]: summary(b, 'Revisão', 2), [c]: summary(c, 'Outro projeto', 3) },
  }
  const workspace = (workspaceId: WorkspaceId, title: string, sessionIds: SessionId[]) => ({
    workspaceId, title, sessionIds, path: `/work/${workspaceId}`, createdAt: '', updatedAt: '',
  })
  const workspaces: WorkspaceSnapshot = {
    items: [workspace(other, 'Outro', [c]), workspace(project, 'Suri', [a, b])],
    archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }
  const pane = { kind: 'pane' as const, id: 'empty', sessionId: null, workspaceId: project }
  const state: PaneSnapshot = {
    layout: { version: 1, focused: pane.id, root: {
      kind: 'split', id: 'split', axis: 'x', ratio: 0.5,
      first: { kind: 'pane', id: 'existing', sessionId: b, workspaceId: project }, second: pane,
    } },
    restoring: false, references: new Map(), choosing: pane.id, busy: null, failure: null, focusRequest: null,
  }
  const copy: Readonly<Record<string, string>> = pt
  const props: ChoicesProps = {
    pane, inline: true, t: key => copy[key] ?? key,
    useSessions: select => select(catalog), useWorkspaces: select => select(workspaces), usePanes: select => select(state),
    selectConversation: vi.fn(), createConversation: vi.fn().mockResolvedValue(undefined),
  }
  return { props, workspaces, catalog }
}

it('inherits the pane project, filters recent conversations and creates in that project', () => {
  const { props } = fixture()
  render(<Choices {...props} />)
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Projeto' }).value).toBe(project)
  expect(screen.queryByText('Outro projeto')).toBeNull()
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Nova conversa', 'RevisãoAberta', 'Integração'])
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }))
  expect(props.createConversation).toHaveBeenCalledWith('empty', project)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: other } })
  expect(screen.queryByText('Integração')).toBeNull()
  expect(screen.getByText('Outro projeto')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Nova conversa' }))
  expect(props.createConversation).toHaveBeenLastCalledWith('empty', other)
})

it('focuses search, opens a matching conversation with Enter, and walks results with arrows', () => {
  const { props } = fixture()
  render(<Choices {...props} />)
  const search = screen.getByRole('textbox', { name: 'Buscar conversa' })
  expect(document.activeElement).toBe(search)
  fireEvent.keyDown(search, { key: 'ArrowDown' })
  expect(document.activeElement?.textContent).toBe('RevisãoAberta')
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement?.textContent).toBe('Integração')
  fireEvent.change(search, { target: { value: 'integra' } })
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(props.selectConversation).toHaveBeenCalledWith('empty', a)
})

it('does not submit a search while an IME composition is ending', () => {
  const { props } = fixture()
  render(<Choices {...props} />)
  const search = screen.getByRole('textbox')
  fireEvent.compositionStart(search)
  fireEvent.keyDown(search, { key: 'Enter' })
  fireEvent.compositionEnd(search)
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(props.selectConversation).not.toHaveBeenCalled()
  fireEvent.keyUp(search, { key: 'Enter' })
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(props.selectConversation).toHaveBeenCalledWith('empty', b)
})

it('shows an empty result and keeps the create action available', () => {
  const { props } = fixture()
  render(<Choices {...props} />)
  const search = screen.getByRole('textbox')
  fireEvent.change(search, { target: { value: 'sem correspondência' } })
  expect(screen.getByText('Nenhuma conversa encontrada.')).toBeTruthy()
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(props.selectConversation).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Nova conversa' }).disabled).toBe(false)
})
