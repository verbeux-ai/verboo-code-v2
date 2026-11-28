import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PaneSnapshot } from './controller.ts'
import { leaves, type PaneLeaf } from './layout.ts'

/** Resolve a focused Session only after its pane has retained a live binding.
 * @param snapshot - current pane layout and retained session references.
 * @param sessions - service that resolves live session bindings.
 * @returns the focused session ID and its binding when ready.
 */
export function focusedBinding(
  snapshot: PaneSnapshot, sessions: Pick<ISessions, 'scope' | 'binding'>,
): { session: PaneLeaf['sessionId']; binding: ReturnType<ISessions['binding']> } {
  const pane = leaves(snapshot.layout.root).find(item => item.id === snapshot.layout.focused)
  const session = pane?.sessionId ?? null
  const reference = pane === undefined ? undefined : snapshot.references.get(pane.id)
  const binding = session !== null && reference?.sessionId === session && sessions.scope(session) !== undefined
    ? sessions.binding(session) : undefined
  return { session, binding }
}
