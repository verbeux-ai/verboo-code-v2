/**
 * The account service: what a login reports, how a token is renewed, and the
 * guarantees that keep a token out of every observable surface.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiAccount, claimsOf, pkcePair } from '../src/account.ts'
import { AccountHttp, AccountRequestError, operation } from '../src/http.ts'
import { GrantVault } from '../src/vault.ts'
import * as AccountPlugin from '../src/index.ts'

describe('account deployment and HTTP evidence', () => {
  it.each([
    [{ tokenUrl: 'relative' }, /not an absolute URL/],
    [{ tokenUrl: 'http://127.0.0.1:1/token' }, /not an allowed OAuth endpoint/],
    [{ tokenUrl: 'https://fixture.test/token?debug=1' }, /not an allowed OAuth endpoint/],
    [{ scopes: [] }, /non-empty list/],
    [{ scopes: ['openid', ' '] }, /non-empty list/],
    [{ scopes: ['openid'] }, /include offline_access/],
    [{ clientId: ' ' }, /clientId must not be blank/],
  ] satisfies Array<[AccountPlugin.Config, RegExp]>)('rejects an invalid OAuth deployment (%j)', (candidate, message) => {
    expect(() => AccountPlugin.deploymentOf(candidate)).toThrow(message)
  })

  it('accepts HTTP only when loopback fixtures opt in', () => {
    const tokenUrl = 'http://127.0.0.1:1/token'
    expect(AccountPlugin.deploymentOf({ tokenUrl, allowLoopbackHttp: true }).tokenUrl).toBe(tokenUrl)
  })

  it.each(['request_cancelled', 'request_timeout'] as const)('reports a bounded request as %s', async (code) => {
    const caller = new AbortController()
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    if (code === 'request_cancelled') caller.abort()
    else deadline.abort()
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      init.signal!.throwIfAborted()
      return new Response('{}')
    })
    vi.stubGlobal('fetch', fetch)
    await expect(new AccountHttp(100).json('https://fixture.test/token', { method: 'POST' }, operation(caller.signal)))
      .rejects.toMatchObject({ code })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('accepts an empty response and classifies a malformed response', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('invalid json', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const http = new AccountHttp(1000)
    const request = operation(new AbortController().signal)
    await expect(http.json('https://fixture.test/revoke', { method: 'POST' }, request))
      .resolves.toEqual({ status: 204, body: undefined })
    await expect(http.json('https://fixture.test/token', { method: 'POST' }, request))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })
})

/** Build one unsigned JWT whose payload carries the given claims. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`
}

/** The plan block the [OI] ID token nests its facts under. */
const AUTH_CLAIMS = 'https://api.openai.com/auth'

/** A token response naming a team plan that runs for a year. */
function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const exp = Math.floor(Date.now() / 1000) + 3600
  return {
    access_token: 'access-token-value',
    refresh_token: 'refresh-token-value',
    id_token: jwt({
      exp,
      [AUTH_CLAIMS]: {
        chatgpt_account_id: 'account-1',
        chatgpt_plan_type: 'team',
        chatgpt_subscription_active_until: '2027-03-12T00:00:00+00:00',
      },
    }),
    ...overrides,
  }
}

/** An in-memory credential store so the vault never touches the OS keyring. */
function memoryStore(): { getSecret(): Promise<number[] | null>; setSecret(secret: Uint8Array): Promise<void> } {
  let value: number[] | null = null
  return {
    getSecret: async () => value,
    setSecret: async (secret) => { value = [...secret] },
  }
}

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-openai-account-'))
  homes.push(home)
  return home
}

async function openAccount(home: string, vault?: GrantVault): Promise<OpenAiAccount> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: { DSH_HOME: home } },
  ]))
  const service = new OpenAiAccount(ctx, {}, vault)
  await ctx.plugin({ apply: () => undefined })
  return service
}

async function accountFixture(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const home = await fixtureHome()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(input instanceof URL ? input.href : input instanceof Request ? input.url : input, init ?? {})))
  const vault = new GrantVault('https://auth.openai.com/oauth/token', home, memoryStore())
  const reopen = () => openAccount(home, vault)
  return { service: await reopen(), reopen, home }
}

/** Mount the account service with a stubbed transport and an in-memory vault. */
async function harness(handler: Parameters<typeof accountFixture>[0]): Promise<OpenAiAccount> {
  return (await accountFixture(handler)).service
}

it('mounts the default account and its login surface for an empty installation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-openai-empty-'))
  const ctx = new Context()
  try {
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { DSH_HOME: home } },
    ]))
    ctx.provide('credentials', {} as never)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin({ name: AccountPlugin.name, inject: AccountPlugin.inject, apply: AccountPlugin.apply })
    const login = ctx.get('openaiAccountLogin') as AccountPlugin.OpenAiAccountLogin
    expect(login).toBeInstanceOf(AccountPlugin.OpenAiAccountLogin)
    expect(await login.status()).toEqual({ signedIn: false })
    expect(await ctx.openaiAccount.status()).toEqual({ signedIn: false })
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

describe('ID token claims', () => {
  it('treats an invalid or absent claim as display metadata with no default plan', () => {
    const nonObject = Buffer.from('null').toString('base64url')
    expect(claimsOf(`x.${nonObject}.x`)).toEqual({})
    expect(claimsOf(jwt({ exp: 'bad metadata' }))).toEqual({})
  })
  it('reads the plan facts the login already carries, without a second request', () => {
    const claims = claimsOf(jwt({
      exp: 1_800_000_000,
      [AUTH_CLAIMS]: {
        chatgpt_account_id: 'account-1',
        chatgpt_plan_type: 'team',
        chatgpt_subscription_active_until: '2027-03-12T00:00:00+00:00',
      },
    }))
    expect(claims).toEqual({
      accountId: 'account-1',
      planType: 'team',
      activeUntil: '2027-03-12T00:00:00+00:00',
      expiresAt: 1_800_000_000_000,
    })
  })

  it('reports no facts for a token this build cannot decode, instead of failing the login', () => {
    expect(claimsOf('not-a-jwt')).toEqual({})
    expect(claimsOf('a.%%%.c')).toEqual({})
    expect(claimsOf(jwt({ exp: 1 }))).toEqual({ expiresAt: 1000 })
  })
})

describe('PKCE', () => {
  it('derives the S256 challenge from the verifier it keeps', () => {
    const pair = pkcePair()
    expect(createHash('sha256').update(pair.verifier).digest('base64url')).toBe(pair.challenge)
  })

  it('issues a distinct verifier per login', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier)
  })
})

describe('login', () => {
  it('addresses the authorization endpoint with the Codex-compatible parameters', async () => {
    const service = await harness(() => new Response('{}'))
    const { url } = service.begin('http://127.0.0.1:1234/callback', new AbortController().signal)
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('scope')).toContain('offline_access')
    expect(parsed.searchParams.get('originator')).toBe('codex_cli_rs')
  })

  it('persists the grant and reports the plan the token names', async () => {
    const service = await harness(() => new Response(JSON.stringify(tokenResponse()), { status: 200 }))
    const status = await service.complete('code', 'verifier', 'http://127.0.0.1:1234/callback', new AbortController().signal)
    expect(status).toEqual({
      signedIn: true,
      planType: 'team',
      accountId: 'account-1',
      activeUntil: '2027-03-12T00:00:00+00:00',
    })
  })

  it('reports signed out before any login', async () => {
    const service = await harness(() => new Response('{}'))
    await expect(service.status()).resolves.toEqual({ signedIn: false })
    await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
  })

  it('keeps a Host signed out while its OS keyring is disabled', async () => {
    vi.stubEnv('DSH_DISABLE_OS_KEYRING', '1')
    try {
      const service = await openAccount(await fixtureHome())
      await expect(service.status()).resolves.toEqual({ signedIn: false })
      await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reopens an isolated encrypted grant and reports unreadable data without deleting it', async () => {
    const { service, reopen, home } = await accountFixture(() => new Response(JSON.stringify(tokenResponse())))
    const signal = new AbortController().signal
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', signal)
    const reopened = await reopen()
    await expect(reopened.accessToken(signal)).resolves.toBe('access-token-value')
    const path = join(home, 'openai-account.grant.json')
    await writeFile(path, 'unreadable fixture')
    await expect((await reopen()).status()).resolves.toEqual({ signedIn: false })
    await expect(readFile(path, 'utf8')).resolves.toBe('unreadable fixture')
  })

  it('keeps a valid login whose identity token carries no optional plan or expiry facts', async () => {
    const result = tokenResponse({ id_token: jwt({}) })
    const service = await harness(() => new Response(JSON.stringify(result)))
    const signal = new AbortController().signal
    await expect(service.complete('code', 'verifier', 'http://127.0.0.1/cb', signal))
      .resolves.toEqual({ signedIn: true })
    await expect(service.accessToken(signal)).resolves.toBe('access-token-value')
  })

  it.each([new Response('null'), new Response('{}', { status: 503 })])(
    'classifies an unexpected exchange without saving a grant', async (response) => {
      const service = await harness(() => response)
      await expect(service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal))
        .rejects.toMatchObject({ code: 'invalid_response' })
      await expect(service.status()).resolves.toEqual({ signedIn: false })
    },
  )

  it('reports a vault write failure without exposing an unusable grant', async () => {
    vi.spyOn(GrantVault.prototype, 'prepare').mockRejectedValueOnce(new Error('Fixture vault unavailable'))
    const service = await harness(() => new Response(JSON.stringify(tokenResponse())))
    await expect(service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal))
      .rejects.toMatchObject({ code: 'credential_store_unavailable' })
    await expect(service.status()).resolves.toEqual({ signedIn: false })
  })

  it('refuses a token response without the fields the route needs', async () => {
    const service = await harness(() => new Response(JSON.stringify({ access_token: 'only' }), { status: 200 }))
    await expect(service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('classifies a rejected exchange without echoing the provider text', async () => {
    const service = await harness(() => new Response('{"error":"invalid_grant"}', { status: 400 }))
    const failure = await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AccountRequestError)
    expect((failure as AccountRequestError).code).toBe('session_expired')
    expect(String(failure)).not.toContain('access-token-value')
    expect(String(failure)).not.toContain('invalid_grant')
  })
})

describe('token renewal', () => {
  it.each([false, true])('shares one token rotation with two callers (first cancels: %s)', async (cancelFirst) => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let renewals = 0
    const service = await harness(async (_url, init) => {
      const form = new URLSearchParams(String(init.body))
      if (form.get('grant_type') !== 'refresh_token') {
        return new Response(JSON.stringify(tokenResponse({
          id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
        })), { status: 200 })
      }
      renewals++
      if (renewals !== 1) return new Response('{"error":"invalid_grant"}', { status: 401 })
      entered.resolve(undefined)
      await release.promise
      return new Response(JSON.stringify(tokenResponse({ access_token: 'fixture-replacement' })), { status: 200 })
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    const controller = new AbortController()
    const first = service.accessToken(controller.signal)
    await entered.promise
    const second = service.accessToken(new AbortController().signal)
    if (cancelFirst) {
      controller.abort()
      await expect(first).rejects.toMatchObject({ code: 'request_cancelled' })
    }
    release.resolve(undefined)
    if (!cancelFirst) await expect(first).resolves.toBe('fixture-replacement')
    await expect(second).resolves.toBe('fixture-replacement')
    expect(renewals).toBe(1)
    await expect(service.status()).resolves.toMatchObject({ signedIn: true })
  })

  it.each([200, 401])('ignores a late refresh with HTTP %s after a replacement login', async (lateStatus) => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const service = await harness(async (_url, init) => {
      const form = new URLSearchParams(String(init.body))
      if (form.get('grant_type') === 'refresh_token') {
        entered.resolve(undefined)
        await release.promise
        return lateStatus === 401
          ? new Response('{"error":"invalid_grant"}', { status: 401 })
          : new Response(JSON.stringify(tokenResponse({ access_token: 'fixture-old-refresh' })), { status: 200 })
      }
      const body = form.get('code') === 'old'
        ? tokenResponse({ id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10 }) })
        : tokenResponse({ access_token: 'fixture-new-owner' })
      return new Response(JSON.stringify(body), { status: 200 })
    })
    const signal = new AbortController().signal
    await service.complete('old', 'verifier', 'http://127.0.0.1/cb', signal)
    const stale = service.accessToken(signal)
    await entered.promise
    await service.complete('new', 'verifier', 'http://127.0.0.1/cb', signal)
    release.resolve(undefined)
    await expect(stale).resolves.toBeUndefined()
    await expect(service.accessToken(signal)).resolves.toBe('fixture-new-owner')
    await expect(service.status()).resolves.toMatchObject({ signedIn: true })
  })

  it('rejects an already cancelled caller before it can renew', async () => {
    const service = await harness(() => new Response(JSON.stringify(tokenResponse({
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
    }))))
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(AbortSignal.abort())).rejects.toMatchObject({ code: 'request_cancelled' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps the existing account when the provider returns an unusable renewal response', async () => {
    let requests = 0
    const service = await harness(() => ++requests === 1
      ? new Response(JSON.stringify(tokenResponse({ id_token: jwt({ exp: 1 }) })))
      : new Response('null'))
    const signal = new AbortController().signal
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', signal)
    await expect(service.accessToken(signal)).resolves.toBeUndefined()
    await expect(service.status()).resolves.toEqual({ signedIn: true })
    expect(requests).toBe(2)
  })

  it('returns the stored token while it is still fresh', async () => {
    const calls: string[] = []
    const service = await harness((url, init) => {
      calls.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`)
      return new Response(JSON.stringify(tokenResponse()), { status: 200 })
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    const before = calls.length
    await expect(service.accessToken(new AbortController().signal)).resolves.toBe('access-token-value')
    expect(calls.length).toBe(before)
  })

  it('renews an expired token and presents the rotated refresh token next time', async () => {
    let exchange = 0
    const bodies: string[] = []
    // Every issued token is already expired, so each read must renew and each
    // renewal proves which refresh token the service presents.
    const expired = (access: string, refresh: string): Record<string, unknown> => tokenResponse({
      access_token: access,
      refresh_token: refresh,
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10, [AUTH_CLAIMS]: { chatgpt_plan_type: 'team' } }),
    })
    const service = await harness((_url, init) => {
      exchange += 1
      bodies.push(init.body instanceof URLSearchParams ? init.body.toString() : typeof init.body === 'string' ? init.body : '')
      return new Response(JSON.stringify(expired(`access-${exchange}`, `refresh-${exchange}`)), { status: 200 })
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(new AbortController().signal)).resolves.toBe('access-2')
    expect(bodies[1]).toContain('grant_type=refresh_token')
    expect(bodies[1]).toContain('refresh_token=refresh-1')
    // Rotation: the exchange spent `refresh-1`, so the next renewal presents
    // the replacement the provider issued, never the spent one.
    await expect(service.accessToken(new AbortController().signal)).resolves.toBe('access-3')
    expect(bodies.at(-1)).toContain('refresh_token=refresh-2')
  })

  it('clears the session when the provider rejects the refresh grant', async () => {
    let exchange = 0
    const service = await harness(() => {
      exchange += 1
      if (exchange === 1)
        return new Response(JSON.stringify(tokenResponse({
          id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10, [AUTH_CLAIMS]: { chatgpt_plan_type: 'team' } }),
        })), { status: 200 })
      return new Response('{"error":"invalid_grant"}', { status: 401 })
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
    await expect(service.status()).resolves.toEqual({ signedIn: false })
  })

  it('keeps the session when renewal fails for a transient reason', async () => {
    let exchange = 0
    const service = await harness(() => {
      exchange += 1
      if (exchange === 1)
        return new Response(JSON.stringify(tokenResponse({
          id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10, [AUTH_CLAIMS]: { chatgpt_plan_type: 'team' } }),
        })), { status: 200 })
      throw new TypeError('fetch failed')
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
    // A network failure is not a rejection of the grant, so the plan still reads.
    await expect(service.status()).resolves.toMatchObject({ signedIn: true, planType: 'team' })
  })
})

describe('sign out', () => {
  it('drops the session and reports signed out', async () => {
    const service = await harness(() => new Response(JSON.stringify(tokenResponse()), { status: 200 }))
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await service.signOut()
    await expect(service.status()).resolves.toEqual({ signedIn: false })
    await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
  })

  it.each(['exchange', 'write'] as const)('discards an authorization still in %s when the user signs out', async (stage) => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const wait = async () => {
      entered.resolve(undefined)
      await release.promise
    }
    const service = await harness(async () => {
      if (stage === 'exchange') await wait()
      return new Response(JSON.stringify(tokenResponse()))
    })
    if (stage === 'write') {
      const prepare = GrantVault.prototype.prepare
      vi.spyOn(GrantVault.prototype, 'prepare').mockImplementationOnce(async function (this: GrantVault) {
        await wait()
        await prepare.call(this)
      })
    }
    const authorization = expect(service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal))
      .rejects.toMatchObject({ code: 'request_cancelled' })
    await entered.promise
    const out = service.signOut()
    release.resolve(undefined)
    await authorization
    await out
    await expect(service.status()).resolves.toEqual({ signedIn: false })
  })

  it('does not republish a refreshed grant while its encrypted write is completing after sign-out', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { service, reopen } = await accountFixture((_url, init) => {
      const isRefresh = new URLSearchParams(String(init.body)).get('grant_type') === 'refresh_token'
      return new Response(JSON.stringify(isRefresh ? tokenResponse() : tokenResponse({ id_token: jwt({ exp: 1 }) })))
    })
    const signal = new AbortController().signal
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', signal)
    const prepare = GrantVault.prototype.prepare
    vi.spyOn(GrantVault.prototype, 'prepare').mockImplementationOnce(async function (this: GrantVault) {
      entered.resolve(undefined)
      await release.promise
      await prepare.call(this)
    })
    const renewal = service.accessToken(signal)
    await entered.promise
    const out = service.signOut()
    release.resolve(undefined)
    await expect(renewal).resolves.toBeUndefined()
    await out
    await expect((await reopen()).status()).resolves.toEqual({ signedIn: false })
  })

  it('does not lend a replacement account to a caller reading the previous grant', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { service, reopen } = await accountFixture((_url, init) => {
      const code = new URLSearchParams(String(init.body)).get('code')
      return new Response(JSON.stringify(tokenResponse({ access_token: code })))
    })
    const signal = new AbortController().signal
    await service.complete('fixture-old', 'verifier', 'http://127.0.0.1/cb', signal)
    const replacement = await reopen()
    const open = GrantVault.prototype.open
    vi.spyOn(GrantVault.prototype, 'open').mockImplementationOnce(async function (this: GrantVault, envelope: unknown) {
      entered.resolve(undefined)
      await release.promise
      return open.call(this, envelope)
    })
    const old = replacement.accessToken(signal)
    await entered.promise
    await replacement.complete('fixture-new', 'verifier', 'http://127.0.0.1/cb', signal)
    release.resolve(undefined)
    await expect(old).resolves.toBeUndefined()
    await expect(replacement.accessToken(signal)).resolves.toBe('fixture-new')
  })
})

describe('first sign-in on a fresh installation', () => {
  it('creates the vault key instead of failing the login', async () => {
    // A vault the service has never written to holds no key, and sealing reads
    // one; the first login must create it rather than report an unusable store.
    const service = await harness(() => new Response(JSON.stringify(tokenResponse()), { status: 200 }))
    await expect(service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal))
      .resolves.toMatchObject({ signedIn: true, planType: 'team' })
  })
})

describe('the callback the browser returns to', () => {
  it('accepts a code only when the state belongs to this attempt', () => {
    // The provider echoes the state it was given; any other value did not come
    // from this attempt, which is what stops a page handing over a foreign code.
    expect(OpenAiAccount.stateMatches('abc', 'abc')).toBe(true)
    expect(OpenAiAccount.stateMatches('abc', 'abd')).toBe(false)
    expect(OpenAiAccount.stateMatches('abc', 'ab')).toBe(false)
    expect(OpenAiAccount.stateMatches('abc', null)).toBe(false)
    expect(OpenAiAccount.stateMatches('abc', '')).toBe(false)
  })

  it('carries the state in the authorization request', () => {
    const service = new OpenAiAccount(new Context(), {})
    const started = service.begin('http://127.0.0.1:1/cb', new AbortController().signal)
    // The same value the callback must echo is the one the request carried.
    expect(new URL(started.url).searchParams.get('state')).toBe(started.state)
    expect(started.state.length).toBeGreaterThan(10)
  })

  it('issues a distinct state per attempt', () => {
    const service = new OpenAiAccount(new Context(), {})
    const first = service.begin('http://127.0.0.1:1/cb', new AbortController().signal)
    const second = service.begin('http://127.0.0.1:1/cb', new AbortController().signal)
    expect(first.state).not.toBe(second.state)
  })
})

describe('where the grant lives', () => {
  it('never resolves the home from the working directory', async () => {
    // A packaged application starts in a directory the reader never chose, so a
    // grant stored there would not survive a restart on any platform.
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../src/account.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('process.cwd()')
    expect(source).toContain('homedir()')
  })

  it('names a keyring backend only where the platform needs one', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../src/vault.ts', import.meta.url), 'utf8')
    // macOS and Windows pick their own store; naming a Linux backend there
    // would leave the key unreadable.
    expect(source).toContain("process.platform === 'linux'")
  })
})
