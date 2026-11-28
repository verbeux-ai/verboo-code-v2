import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, type ISessions, type SessionBinding, type SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneSnapshot } from '../src/client/panes/controller.ts'
import { focusedBinding } from '../src/client/panes/focused-binding.ts'

it('waits for a restored pane reference, scope and binding before using the model directory', async () => {
  const id = 'restored' as SessionId
  const snapshot: PaneSnapshot = {
    layout: { version: 1, root: { kind: 'pane', id: 'pane', sessionId: id }, focused: 'pane' },
    restoring: false,
    references: new Map(),
    choosing: null,
    busy: null,
    failure: null,
    focusRequest: null,
  }
  const scope = vi.fn<ISessions['scope']>()
  const binding = vi.fn<ISessions['binding']>()
  const sessions = { scope, binding }
  expect(focusedBinding(snapshot, sessions).binding).toBeUndefined()
  expect(scope).not.toHaveBeenCalled()
  const handle = createScope(new Context(), id)
  try {
    const ready = { sessionId: id, ctx: handle.ctx } as SessionBinding
    const release = vi.fn()
    const reference: SessionReference = {
      sessionId: id,
      binding: ready,
      ready: Promise.resolve(ready),
      release,
      [Symbol.dispose]: release,
    }
    const retained: PaneSnapshot = { ...snapshot, references: new Map([['pane', reference]]) }
    expect(focusedBinding(retained, sessions).binding).toBeUndefined()
    expect(binding).not.toHaveBeenCalled()
    scope.mockReturnValue(handle.ctx)
    binding.mockReturnValue(ready)
    expect(focusedBinding(retained, sessions)).toEqual({ session: id, binding: ready })
  } finally {
    await handle.fiber.dispose()
  }
})
