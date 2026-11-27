import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PaneSnapshot } from './controller.ts'
import { leaves } from './layout.ts'

/** Resolve a focused Session only after its pane has retained a live binding. */
export function focusedBinding(snapshot: PaneSnapshot, sessions: Pick<ISessions, 'scope' | 'binding'>) {
  const pane = leaves(snapshot.layout.root).find(item => item.id === snapshot.layout.focused)
  const session = pane?.sessionId ?? null
  const reference = pane === undefined ? undefined : snapshot.references.get(pane.id)
  const binding = session !== null && reference?.sessionId === session && sessions.scope(session) !== undefined
    ? sessions.binding(session) : undefined
  return { session, binding }
}
