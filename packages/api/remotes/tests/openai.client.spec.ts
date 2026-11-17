/** The application assembly exposes the ChatGPT methods the connection dialog calls. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { apply as applyGateway, inject as gatewayInject } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { apply, inject } from '../src/client/index.ts'

describe('ChatGPT Client Remote assembly', () => {
  it('dispatches login and subscription calls and removes them on disposal', async () => {
    const ctx = new Context()
    const call = vi.fn<ConnectionHandle['rpc']['call']>(async (_prefix, endpoint) => {
      switch (endpoint) {
        case 'openaiAccountLogin/beginLogin': return { ok: true, value: { url: 'https://auth.openai.com/oauth/authorize', handle: 'login-1' } }
        case 'openaiAccountLogin/awaitLogin':
        case 'openaiAccountLogin/status': return { ok: true, value: { signedIn: true } }
        case 'llmOpenaiAccount/discoverModels': return { ok: true, value: { supported: [], unsupported: [], skipped: [], stoppedAtLimit: false } }
        default: return { ok: true, value: undefined }
      }
    })
    ctx.provide('connection', {
      interactions: 'none',
      isLoopback: true,
      openWebSocket: () => { throw new Error('Unexpected WebSocket') },
      generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
      state: { getSnapshot: () => undefined, subscribe: () => () => {} },
      reconnect: () => {},
      rpc: { call, open: async function* () { throw new Error('Unexpected stream') } },
      registerGenerationSource: () => () => {},
      start: () => ({ stop: () => {} }),
    } satisfies ConnectionHandle)
    try {
      await ctx.plugin(TypertRegistry)
      await ctx.plugin({ inject: gatewayInject, apply: applyGateway })
      const assembly = ctx.plugin({ inject, apply })
      await assembly
      await expect(ctx.remote.openaiAccountLogin.beginLogin('http://localhost:1455/auth/callback')).resolves.toEqual({
        ok: true, value: { url: 'https://auth.openai.com/oauth/authorize', handle: 'login-1' },
      })
      await expect(ctx.remote.openaiAccountLogin.status()).resolves.toEqual({ ok: true, value: { signedIn: true } })
      await expect(ctx.remote.openaiAccountLogin.awaitLogin('login-1')).resolves.toEqual({ ok: true, value: { signedIn: true } })
      await expect(ctx.remote.llmOpenaiAccount.usage()).resolves.toEqual({ ok: true, value: undefined })
      await expect(ctx.remote.llmOpenaiAccount.discoverModels()).resolves.toEqual({
        ok: true, value: { supported: [], unsupported: [], skipped: [], stoppedAtLimit: false },
      })
      await expect(ctx.remote.openaiAccountLogin.signOut()).resolves.toEqual({ ok: true, value: undefined })
      expect(call.mock.calls.map(([, endpoint]) => endpoint)).toEqual([
        'openaiAccountLogin/beginLogin', 'openaiAccountLogin/status', 'openaiAccountLogin/awaitLogin',
        'llmOpenaiAccount/usage', 'llmOpenaiAccount/discoverModels', 'openaiAccountLogin/signOut',
      ])
      await assembly.dispose()
      expect(ctx.get('remote.openaiAccountLogin')).toBeUndefined()
      expect(ctx.get('remote.llmOpenaiAccount')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
