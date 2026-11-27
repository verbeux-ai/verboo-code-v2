import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { leaves, type PaneLayout } from './layout.ts'

/** Resolve a focused Session only after its pane has retained a live binding.
 * @param snapshot - current pane layout and retained session references.
 * @param sessions - service that resolves live session bindings.
 * @returns the focused session ID and its binding when ready.
 */
export function focusedBinding<Binding>(
  snapshot: { layout: PaneLayout; references: ReadonlyMap<string, { readonly sessionId: SessionId }> },
  sessions: { scope(id: SessionId): object | undefined; binding(id: SessionId): Binding | undefined },
): { session: SessionId | null; binding: Binding | undefined } {
  const pane = leaves(snapshot.layout.root).find(item => item.id === snapshot.layout.focused)
  const session = pane?.sessionId ?? null
  const reference = pane === undefined ? undefined : snapshot.references.get(pane.id)
  const binding = session !== null && reference?.sessionId === session && sessions.scope(session) !== undefined
    ? sessions.binding(session) : undefined
  return { session, binding }
}
