// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ConversationSwitcher, sidebarConversationOrder, stepConversation } from '../src/client/panes/ConversationSwitcher.tsx'

const row = (name: string, options: Partial<SessionSummary> = {}) =>
  ({ id: name as SessionId, displayTitle: name, blank: false, ...options }) as SessionSummary

it('takes project rows in sidebar order, then ungrouped rows, skipping archived, draft and agent rows', () => {
  const [a, b, c, archived, draft, agent] = [
    row('First'), row('Second'), row('Ungrouped'), row('Archived'),
    row('Draft', { blank: true }), row('Agent', { origin: 'subagent' }),
  ] as const
  const rows = [c, archived, b, a, draft, agent]
  const sessions: SessionListState = {
    ids: rows.map(r => r.id), byId: Object.fromEntries(rows.map(r => [r.id, r])),
    phase: 'ready', projectionsBySession: {},
  }
  const workspace = { items: [{ sessionIds: [a.id, b.id, draft.id] }], archivedSessionIds: [archived.id] } as WorkspaceSnapshot
  expect(sidebarConversationOrder(sessions, workspace, undefined)).toEqual([a, b, c])
  expect(sidebarConversationOrder(sessions, workspace, draft.id)).toEqual([a, b, draft, c])
})

it('wraps forward and backward from the current conversation, keeping the sequence frozen while held', () => {
  const rows = [row('First'), row('Second'), row('Third')]
  const first = stepConversation(rows, rows[2]!.id, 1, null)
  expect(first?.selected).toBe(0)
  expect(stepConversation([], rows[0]!.id, -1, first)?.selected).toBe(2)
  expect(stepConversation(rows, undefined, -1, null)?.selected).toBe(2)
  expect(stepConversation(rows.slice(0, 1), undefined, 1, null)).toBeNull()
  const view = render(<ConversationSwitcher useConversationSwitch={select => select(first)}
    t={(key, values) => key === 'switchConversation' ? 'Switch conversation' : `${String(values?.title)}, ${String(values?.position)} of ${String(values?.total)}`} />)
  expect(screen.getByText('First').getAttribute('aria-current')).toBe('true')
  expect(screen.getByRole('status').textContent).toBe('First, 1 of 3')
  view.unmount()
})
