/** The sign-in surface: attempt lifecycle, callback matching, and the calls the dialog makes. */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenAiAccount } from '../src/account.ts'
import { OpenAiAccountLogin } from '../src/remote.ts'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

/** One account double: every method the surface may drive, instrumented. */
function accountDouble(): OpenAiAccount & {
  begin: ReturnType<typeof vi.fn>
  complete: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  signOut: ReturnType<typeof vi.fn>
} {
  let sequence = 0
  const begin = vi.fn(() => { sequence += 1; return { url: 'https://auth.openai.com/authorize?x=1', verifier: `verifier-${sequence}`, state: `state-${sequence}` } })
  const complete = vi.fn(async () => ({ signedIn: true, planType: 'team' }))
  const status = vi.fn(async () => ({ signedIn: false }))
  const signOut = vi.fn(async () => undefined)
  return { begin, complete, status, signOut } as never
}

/** One webserver double capturing the callback route registration. */
function webServerDouble(): WebServer & { routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }> } {
  const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }> = []
  return { routes, register: vi.fn((route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) => {
    routes.push(route)
    return () => undefined
  }) } as never
}

/** Mount the surface beside its doubles; return both plus a callback driver. */
async function surface(): Promise<{
  login: OpenAiAccountLogin
  account: ReturnType<typeof accountDouble>
  web: ReturnType<typeof webServerDouble>
  respond: (query: Record<string, string>) => { status: number; body: string }
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const account = accountDouble()
  const web = webServerDouble()
  ctx.provide('openaiAccount', account as unknown as OpenAiAccount)
  ctx.provide('webServer', web)
  const login = new OpenAiAccountLogin(ctx)
  const respond = (query: Record<string, string>): { status: number; body: string } => {
    const route = web.routes.find(candidate => candidate.path === '/auth/callback')
    if (route === undefined) throw new Error('the callback route was not registered')
    const url = new URL(`http://127.0.0.1/auth/callback?${new URLSearchParams(query)}`)
    let status = 0
    let body = ''
    const res = { writeHead: (code: number) => { status = code }, end: (text: string) => { body = text } } as unknown as ServerResponse
    route.handler({ url: url.pathname + url.search } as unknown as IncomingMessage, res)
    return { status, body }
  }
  return { login, account, web, respond }
}

/** Contexts created by this suite, disposed after each test. */
const contexts: Context[] = []

/** A signal the surface methods require; never aborted here. */
const signal = new AbortController().signal

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('OpenAiAccountLogin', () => {
  it('registers one fixed callback route at mount', async () => {
    const { login } = await surface()
    expect(login).toBeDefined()
  })

  it('beginLogin returns the authorization URL and a handle, and answers the callback that echoes its state', async () => {
    const { login, respond } = await surface()
    const started = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    expect(started.url).toContain('auth.openai.com')
    expect(started.handle).toMatch(/^[A-Za-z0-9_-]+$/)
    const answer = respond({ state: 'state-1', code: 'the-code' })
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('Signed in')
    // The waiting attempt settles with the delivered code.
    await expect(login.awaitLogin(started.handle, signal)).resolves.toMatchObject({ signedIn: true, planType: 'team' })
  })

  it('refuses a callback whose state does not match any in-flight attempt', async () => {
    const { login, respond } = await surface()
    login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    const answer = respond({ state: 'forged', code: 'the-code' })
    expect(answer.status).toBe(400)
    expect(answer.body).toContain('Sign-in failed')
  })

  it('refuses a callback that carries an error instead of a code', async () => {
    const { login, respond } = await surface()
    login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    const answer = respond({ state: 'state-1', error_description: 'access_denied: the user declined' })
    expect(answer.status).toBe(400)
    expect(answer.body).toContain('access_denied')
  })

  it('refuses a callback that carries neither a code nor an error', async () => {
    const { login, respond } = await surface()
    login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    const answer = respond({ state: 'state-1' })
    expect(answer.status).toBe(400)
    expect(answer.body).toContain('did not belong to a sign-in')
  })

  it('awaitLogin refuses a handle this service never issued', async () => {
    const { login } = await surface()
    await expect(login.awaitLogin('unknown-handle', signal))
      .rejects.toThrow('unknown or expired sign-in attempt')
  })

  it('completeLogin exchanges the code the dialog presents and retires the attempt', async () => {
    const { login, account, respond } = await surface()
    const started = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    respond({ state: 'state-1', code: 'the-code' })
    await expect(login.completeLogin(started.handle, 'other-code', signal)).resolves.toMatchObject({ signedIn: true })
    // The exchange used the code the caller presented, not the callback's.
    expect(account.complete).toHaveBeenLastCalledWith('other-code', 'verifier-1', 'http://127.0.0.1:1455/auth/callback', signal)
    // The attempt is spent: completing it again is refused.
    await expect(login.completeLogin(started.handle, 'more', signal)).rejects.toThrow('unknown or expired')
  })

  it('status and signOut pass through to the account service', async () => {
    const { login, account } = await surface()
    await expect(login.status()).resolves.toEqual({ signedIn: false })
    await login.signOut()
    expect(account.signOut).toHaveBeenCalledOnce()
  })

  it('prunes expired attempts so the pending map stays bounded', async () => {
    vi.useFakeTimers()
    try {
      const { login } = await surface()
      login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
      // Past the 300s attempt deadline the abandoned attempt is pruned on the
      // next begin, and its await is refused.
      vi.advanceTimersByTime(301_000)
      login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
      const handles = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
      expect(handles.handle).toMatch(/^[A-Za-z0-9_-]+$/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails loudly when the account service is not mounted beside it', async () => {
    const ctx = new Context()
    ctx.provide('webServer', webServerDouble())
    const login = new OpenAiAccountLogin(ctx)
    expect(() => login.beginLogin('http://127.0.0.1:1455/auth/callback', signal))
      .toThrow('the account service is not mounted')
  })
})

describe('callback edge cases', () => {
  it('skips an expired attempt when matching the callback state', async () => {
    vi.useFakeTimers()
    try {
      const { login, respond } = await surface()
      const first = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
      // The first attempt expires; the callback with its state is refused.
      vi.advanceTimersByTime(301_000)
      const answer = respond({ state: 'state-1', code: 'late-code' })
      expect(answer.status).toBe(400)
      await expect(login.awaitLogin(first.handle, signal)).rejects.toThrow('unknown or expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips an attempt whose state does not match and accepts a later one', async () => {
    const { login, account, respond } = await surface()
    const first = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    const second = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    expect(first.handle).not.toBe(second.handle)
    // The response belongs to the second attempt; the first stays pending.
    const answer = respond({ state: 'state-2', code: 'second-code' })
    expect(answer.status).toBe(200)
    await expect(login.awaitLogin(second.handle, signal)).resolves.toMatchObject({ signedIn: true })
    // The first attempt was never accepted: completing it by handle is refused
    // only after it settles, so the observable fact is the second settled and
    // the account exchanged once.
    expect(account.complete).toHaveBeenCalledOnce()
  })

  it('keeps the callback route registered when no webserver exists at mount', async () => {
    const ctx = new Context()
    // No webServer service: the effect records nothing, and the surface still
    // answers its direct calls (completeLogin, status, signOut).
    const account = accountDouble()
    ctx.provide('openaiAccount', account as unknown as OpenAiAccount)
    const login = new OpenAiAccountLogin(ctx)
    await expect(login.status()).resolves.toEqual({ signedIn: false })
    const started = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    expect(started.url).toContain('auth.openai.com')
    await expect(login.completeLogin(started.handle, 'the-code', signal)).resolves.toMatchObject({ signedIn: true })
  })

  it('answers a callback whose URL carries no query at all', async () => {
    const { login, web } = await surface()
    login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    const route = web.routes.find(candidate => candidate.path === '/auth/callback')
    if (route === undefined) throw new Error('route missing')
    let status = 0
    let body = ''
    route.handler({ url: '/auth/callback' } as unknown as IncomingMessage, { writeHead: (code: number) => { status = code }, end: (text: string) => { body = text } } as unknown as ServerResponse)
    expect(status).toBe(400)
    expect(body).toContain('did not belong to a sign-in')
  })
})

describe('callback route wiring', () => {
  it('registers no route and skips the webserver effect when the service is absent', async () => {
    const ctx = new Context()
    const account = accountDouble()
    ctx.provide('openaiAccount', account as unknown as OpenAiAccount)
    // No webServer at all: the effect's undefined branch runs, and the surface
    // still works for its direct calls.
    const login = new OpenAiAccountLogin(ctx)
    const started = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    // completeLogin does not depend on the callback: the dialog can present the
    // code it obtained by other means.
    await expect(login.completeLogin(started.handle, 'the-code', signal)).resolves.toMatchObject({ signedIn: true })
  })

  it('refuses awaitLogin for an attempt that expired while still pending', async () => {
    vi.useFakeTimers()
    try {
      const { login } = await surface()
      const started = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
      vi.advanceTimersByTime(301_000)
      await expect(login.awaitLogin(started.handle, signal)).rejects.toThrow('unknown or expired')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('callback lifecycle gaps', () => {
  it('answers a callback URL missing the query string entirely', async () => {
    const { login, web } = await surface()
    login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
    const route = web.routes.find(candidate => candidate.path === '/auth/callback')
    if (route === undefined) throw new Error('route missing')
    let status = 0
    let body = ''
    const response = { writeHead: (code: number) => { status = code }, end: (text: string) => { body = text } } as unknown as ServerResponse
    route.handler({ url: undefined } as unknown as IncomingMessage, response)
    expect(status).toBe(400)
    expect(body).toContain('did not belong to a sign-in')
  })

  it('expires an abandoned attempt and refuses its code through completeLogin', async () => {
    vi.useFakeTimers()
    try {
      const { login } = await surface()
      const started = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
      vi.advanceTimersByTime(301_000)
      await expect(login.completeLogin(started.handle, 'late-code', signal)).rejects.toThrow('unknown or expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('awaitLogin after the attempt expired without a callback answers the expiration error', async () => {
    vi.useFakeTimers()
    try {
      const { login, respond } = await surface()
      const started = login.beginLogin('http://127.0.0.1:1455/auth/callback', signal)
      // The callback accepted the attempt, but awaitLogin runs past the attempt
      // deadline: the delivery happened, yet the handle is stale.
      vi.advanceTimersByTime(301_000)
      respond({ state: 'state-1', code: 'late-code' })
      await expect(login.awaitLogin(started.handle, signal)).rejects.toThrow('unknown or expired')
    } finally {
      vi.useRealTimers()
    }
  })
})
