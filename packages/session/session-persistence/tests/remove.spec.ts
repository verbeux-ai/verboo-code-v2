/**
 * The Service Definition's own removal behavior: a backend that owns no
 * removable artifact refuses loudly instead of reporting a deletion it cannot
 * perform, and cancellation is observed before that refusal.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence, SessionRemoveUnsupportedError,
  type SessionAccess, type SessionHandle, type SessionPersistenceSnapshot,
} from '../src/index.ts'

/** A backend that stores nothing: every read misses and removal is unsupported. */
class EmptyPersistence extends SessionPersistence {
  async create(_header: SessionHeader): Promise<SessionHandle> {
    throw new SessionRemoveUnsupportedError(SessionId('unused'))
  }

  async open(_id: SessionIdType, _access: SessionAccess): Promise<SessionHandle> {
    throw new SessionRemoveUnsupportedError(SessionId('unused'))
  }

  async flush(): Promise<void> {}

  async stat(_id: SessionIdType): Promise<SessionPersistenceSnapshot | undefined> {
    return undefined
  }

  async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return []
  }
}

async function mount(): Promise<SessionPersistence> {
  const ctx = new Context()
  await ctx.plugin(EmptyPersistence)
  return ctx.sessionPersistence
}

describe('SessionPersistence.remove', () => {
  it('refuses by default, naming the session and the backend limitation', async () => {
    const persistence = await mount()
    await expect(persistence.remove(SessionId('nowhere'))).rejects.toThrow(
      'session "nowhere": this persistence backend cannot remove stored sessions',
    )
    await expect(persistence.remove(SessionId('nowhere'))).rejects.toBeInstanceOf(SessionRemoveUnsupportedError)
  })

  it('rejects an aborted request without reaching the refusal', async () => {
    const persistence = await mount()
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    await expect(persistence.remove(SessionId('nowhere'), { signal: controller.signal }))
      .rejects.toThrow('caller cancelled')
  })
})
