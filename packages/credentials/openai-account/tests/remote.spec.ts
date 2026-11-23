import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OpenAiAccount } from '../src/account.ts'
import OpenAiAccountLogin from '../src/remote.ts'

const redirect = 'http://127.0.0.1:1455/auth/callback'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let route: WebRoute | undefined
  let nextAttempt = 0
  const account = {
    begin: vi.fn(() => {
      const state = `fixture-state-${++nextAttempt}`
      return { url: `https://auth.example.test/authorize?state=${state}`, state, verifier: 'test-verifier' }
    }),
    complete: vi.fn(async () => ({ signedIn: true as const })),
    status: vi.fn(async () => ({ signedIn: false as const })),
    signOut: vi.fn(async () => undefined),
  } satisfies Pick<OpenAiAccount, 'begin' | 'complete' | 'status' | 'signOut'>
  ctx.provide('webServer', { register: (registered: WebRoute) => {
    route = registered
    return () => { route = undefined }
  } } as never)
  ctx.provide('openaiAccount', account as unknown as OpenAiAccount)
  await ctx.plugin(OpenAiAccountLogin)
  const login = ctx.get('openaiAccountLogin') as OpenAiAccountLogin
  const signal = new AbortController().signal
  const start = () => {
    const attempt = login.beginLogin(redirect, signal)
    return { ...attempt, state: new URL(attempt.url).searchParams.get('state')! }
  }
  const respond = async (query: Record<string, string> | undefined, method = 'GET') => {
    const writeHead = vi.fn(), end = vi.fn()
    expect(route?.path).toBe('/auth/callback')
    await route!.handler({
      method, ...(query === undefined ? {} : { url: `/auth/callback?${new URLSearchParams(query)}` }),
    } as IncomingMessage, { writeHead, end } as unknown as ServerResponse)
    return { status: writeHead.mock.calls[0]?.[0], headers: writeHead.mock.calls[0]?.[1], html: end.mock.calls[0]?.[0] }
  }
  return { login, account, respond, signal, start }
}

it('shows a fixed callback failure page and preserves the matching sign-in', async () => {
  const h = await fixture()
  const { handle, state } = h.start()
  const waiting = h.login.awaitLogin(handle, h.signal)
  const denied = await h.respond({ state: 'other-attempt', error_description: 'private provider detail' })
  expect(denied.status).toBe(400)
  expect(denied.headers).toMatchObject({ 'cache-control': 'no-store' })
  expect(denied.html).not.toContain('private provider detail')
  expect((await h.respond(undefined)).status).toBe(400)
  expect((await h.respond({ state, code: 'test-code' }, 'POST')).status).toBe(405)
  expect((await h.respond({ state: 'other-attempt', code: 'test-code' })).status).toBe(400)
  expect((await h.respond({ state, code: '' })).status).toBe(400)
  expect((await h.respond({ state, code: 'test-code' })).status).toBe(200)
  await expect(waiting).resolves.toEqual({ signedIn: true })
  expect(h.account.complete).toHaveBeenCalledExactlyOnceWith('test-code', 'test-verifier', redirect, h.signal)
})

it('exchanges each callback once even while two callers are waiting', async () => {
  const h = await fixture()
  const { handle, state } = h.start()
  const waiting = Promise.allSettled([h.login.awaitLogin(handle, h.signal), h.login.awaitLogin(handle, h.signal)])
  expect(h.login.acceptCallback(state, 'test-code')).toBe(true)
  expect(h.login.acceptCallback(state, 'another-code')).toBe(false)
  expect((await waiting).map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(h.account.complete).toHaveBeenCalledOnce()
})

it('lets a caller cancel while waiting and accepts a fresh call for the same attempt', async () => {
  const h = await fixture()
  const { handle, state } = h.start()
  const controller = new AbortController()
  const waiting = h.login.awaitLogin(handle, controller.signal)
  controller.abort(new Error('window closed'))
  await expect(waiting).rejects.toThrow('window closed')
  await expect(h.login.awaitLogin(handle, controller.signal)).rejects.toThrow('window closed')
  await expect(h.login.completeLogin(handle, 'test-code', controller.signal)).rejects.toThrow('window closed')
  expect(h.account.complete).not.toHaveBeenCalled()
  expect(h.login.acceptCallback(state, 'test-code')).toBe(true)
  await expect(h.login.awaitLogin(handle, h.signal)).resolves.toEqual({ signedIn: true })
})

it('ends an open callback wait when the attempt reaches its deadline', async () => {
  const h = await fixture()
  vi.useFakeTimers()
  try {
    const { handle, state } = h.start()
    const waiting = h.login.awaitLogin(handle, h.signal)
    const rejected = expect(waiting).rejects.toThrow('sign-in attempt expired')
    await vi.advanceTimersByTimeAsync(300_000)
    await rejected
    expect(h.login.acceptCallback(state, 'late-code')).toBe(false)
    expect(h.account.complete).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})

it('finishes a direct exchange and retires any concurrent callback wait', async () => {
  const h = await fixture()
  const { handle, state } = h.start()
  const waiting = h.login.awaitLogin(handle, h.signal)
  const rejected = expect(waiting).rejects.toThrow('unknown or expired sign-in attempt')
  await expect(h.login.completeLogin(handle, 'manual-code', h.signal)).resolves.toEqual({ signedIn: true })
  await rejected
  await expect(h.login.awaitLogin(handle, h.signal)).rejects.toThrow('unknown or expired sign-in attempt')
  expect(h.login.acceptCallback(state, 'late-code')).toBe(false)
  await expect(h.login.status()).resolves.toEqual({ signedIn: false })
  await h.login.signOut()
  expect(h.account.signOut).toHaveBeenCalledOnce()
})

it('prunes expired attempts and keeps independent active sign-ins available', async () => {
  const h = await fixture()
  vi.useFakeTimers()
  try {
    const expired = h.start()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.login.acceptCallback(expired.state, 'late-code')).toBe(false)
    await expect(h.login.awaitLogin(expired.handle, h.signal)).rejects.toThrow('unknown or expired sign-in attempt')
    await expect(h.login.completeLogin(expired.handle, 'late-code', h.signal)).rejects.toThrow('unknown or expired sign-in attempt')
    const first = h.start()
    const second = h.start()
    expect(first.handle).not.toBe(second.handle)
    expect(h.login.acceptCallback(second.state, 'second-code')).toBe(true)
    expect(h.login.acceptCallback(first.state, 'first-code')).toBe(true)
    await expect(h.login.awaitLogin(first.handle, h.signal)).resolves.toEqual({ signedIn: true })
    await expect(h.login.awaitLogin(second.handle, h.signal)).resolves.toEqual({ signedIn: true })
    expect(h.account.complete.mock.calls).toHaveLength(2)
  } finally { vi.useRealTimers() }
})

it('rejects account operations after direct composition without the account service', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const login = new OpenAiAccountLogin(ctx)
  await expect(login.status()).rejects.toThrow('account service is not mounted')
})
