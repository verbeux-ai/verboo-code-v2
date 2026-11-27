import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneLayout } from '../src/client/panes/layout.ts'
import { focusedBinding } from '../src/client/panes/focused-binding.ts'

it('waits for a restored pane reference, scope and binding before using the model directory', () => {
  const id = 'restored' as SessionId
  const layout: PaneLayout = { version: 1, root: { kind: 'pane', id: 'pane', sessionId: id }, focused: 'pane' }
  const snapshot = { layout, references: new Map<string, { sessionId: SessionId }>() }
  const scope = vi.fn<(id: SessionId) => object | undefined>()
  const binding = vi.fn<(id: SessionId) => { sessionId: SessionId } | undefined>()
  const sessions = { scope, binding }
  expect(focusedBinding(snapshot, sessions).binding).toBeUndefined()
  expect(scope).not.toHaveBeenCalled()
  const retained = { layout, references: new Map([['pane', { sessionId: id }]]) }
  expect(focusedBinding(retained, sessions).binding).toBeUndefined()
  expect(binding).not.toHaveBeenCalled()
  scope.mockReturnValue({})
  const ready = { sessionId: id }
  binding.mockReturnValue(ready)
  expect(focusedBinding(retained, sessions)).toEqual({ session: id, binding: ready })
})

it('does not resolve a binding for an empty pane or a stale focus or reference', () => {
  const id = 'restored' as SessionId
  const root = { kind: 'pane', id: 'pane', sessionId: id } as const
  const references = new Map([['pane', { sessionId: 'old-session' as SessionId }]])
  const sessions = { scope: vi.fn<() => undefined>(), binding: vi.fn<() => undefined>() }

  expect(focusedBinding({ layout: { version: 1, root, focused: 'missing' }, references }, sessions))
    .toEqual({ session: null, binding: undefined })
  expect(focusedBinding({ layout: { version: 1, root: { ...root, sessionId: null }, focused: 'pane' }, references }, sessions))
    .toEqual({ session: null, binding: undefined })
  expect(focusedBinding({ layout: { version: 1, root, focused: 'pane' }, references }, sessions))
    .toEqual({ session: id, binding: undefined })
  expect(sessions.scope).not.toHaveBeenCalled()
  expect(sessions.binding).not.toHaveBeenCalled()
})
