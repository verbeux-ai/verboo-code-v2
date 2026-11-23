/** The plugin mounting: both services provision under their keys. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.ts'

describe('verboo-account plugin', () => {
  it('declares its name and its injections', () => {
    expect(name).toBe('verboo-account')
    expect(inject).toEqual(['credentials', 'authorization', 'llm'])
  })

  it('apply mounts the account provider and its model transport without throwing', () => {
    const ctx = new Context()
    expect(() => apply(ctx, {
      deployment: {
        clientId: 'client-1',
        scopes: ['openid', 'offline_access'],
        authorizeUrl: 'https://auth.verboo.example/authorize',
        tokenUrl: 'https://auth.verboo.example/token',
        revokeUrl: 'https://auth.verboo.example/revoke',
        apiOrigin: 'https://api.verboo.example',
        requestTimeoutMs: 5_000,
      },
      gateway: { baseUrl: 'https://gateway.verboo.example' },
    } as never)).not.toThrow()
  })
})
