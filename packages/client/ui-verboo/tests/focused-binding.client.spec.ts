import { expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneSnapshot } from '../src/client/panes/controller.ts'
import { focusedBinding } from '../src/client/panes/focused-binding.ts'

it('waits for a restored pane reference, scope and binding before using the model directory', () => {
  const id = 'restored' as SessionId
  const snapshot = { layout: { root: { kind: 'pane', id: 'pane', sessionId: id }, focused: 'pane' }, references: new Map() } as unknown as PaneSnapshot
  const scope = vi.fn().mockReturnValue(undefined)
  const binding = vi.fn().mockReturnValue(undefined)
  const sessions = { scope, binding } as unknown as Pick<ISessions, 'scope' | 'binding'>
  expect(focusedBinding(snapshot, sessions).binding).toBeUndefined()
  expect(scope).not.toHaveBeenCalled()
  const retained = { ...snapshot, references: new Map([['pane', { sessionId: id }]]) } as unknown as PaneSnapshot
  expect(focusedBinding(retained, sessions).binding).toBeUndefined()
  expect(binding).not.toHaveBeenCalled()
  scope.mockReturnValue({})
  const ready = {}
  binding.mockReturnValue(ready)
  expect(focusedBinding(retained, sessions)).toEqual({ session: id, binding: ready })
})
