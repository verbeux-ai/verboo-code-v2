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
