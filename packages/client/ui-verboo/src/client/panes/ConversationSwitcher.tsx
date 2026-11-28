/** Keyboard-only preview of the sidebar conversation order. */
import { createPortal } from 'react-dom'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './Panes.module.css'

/** Rows eligible for the sidebar, preserving the caller's order. */
export function sidebarConversationRows(ids: readonly SessionId[], sessions: SessionListState,
  workspaces: WorkspaceSnapshot, current: SessionId | undefined, archived = false): SessionSummary[] {
  const archive = new Set(workspaces.archivedSessionIds)
  return ids.flatMap((id) => {
    const session = sessions.byId[id]
    return session !== undefined && archive.has(id) === archived && session.origin !== 'subagent'
      && (!session.blank || id === current) ? [session] : []
  })
}

/** Active conversations in project order, then ungrouped sidebar rows. */
export function sidebarConversationOrder(sessions: SessionListState, workspaces: WorkspaceSnapshot,
  current: SessionId | undefined): SessionSummary[] {
  const ids = new Set(workspaces.items.flatMap(project => project.sessionIds))
  for (const id of sessions.ids) ids.add(id)
  return sidebarConversationRows([...ids], sessions, workspaces, current)
}

export interface ConversationSwitch {
  rows: readonly SessionSummary[]
  selected: number
}

/** Step through a frozen sequence so background activity cannot reorder a held shortcut. */
export function stepConversation(rows: readonly SessionSummary[], current: SessionId | undefined,
  direction: 1 | -1, previous: ConversationSwitch | null): ConversationSwitch | null {
  const candidates = previous?.rows ?? rows
  if (candidates.length < 2) return null
  const position = previous?.selected ?? candidates.findIndex(row => row.id === current)
  const start = position < 0 && direction === -1 ? 0 : position
  return { rows: candidates, selected: (start + direction + candidates.length) % candidates.length }
}

/** Passive overlay; the existing conversation retains focus until Control is released. */
export function ConversationSwitcher({ useConversationSwitch, t }: PropsLocale<'verboo'> & InjectFace<{
  hooks: { conversationSwitch: HostObservable<ConversationSwitch | null> }
}>) {
  const selection = useConversationSwitch(value => value)
  if (selection === null) return null
  const { rows, selected } = selection
  const first = Math.min(Math.max(0, selected - 2), Math.max(0, rows.length - 5))
  return createPortal(<section className={css.conversationSwitcher} aria-label={t('switchConversation')}>
    <h2>{t('switchConversation')}</h2>
    <ul>
      {rows.slice(first, first + 5).map(row => <li key={row.id}
        aria-current={row.id === rows[selected]?.id ? 'true' : undefined}>{row.displayTitle}</li>)}
    </ul>
    <span role="status" className={css.conversationSwitchPosition}>
      {t('switchConversationPosition', { title: rows[selected]?.displayTitle ?? '', position: selected + 1, total: rows.length })}
    </span>
  </section>, document.body)
}
