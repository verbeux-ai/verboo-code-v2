/**
 * The account service: what a login reports, how a token is renewed, and the
 * guarantees that keep a token out of every observable surface.
 */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiAccount, claimsOf, pkcePair } from '../src/account.ts'
import { AccountRequestError } from '../src/http.ts'
import { GrantVault } from '../src/vault.ts'

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
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Mount the account service with a stubbed transport and an in-memory vault. */
async function harness(handler: (url: string, init: RequestInit) => Response): Promise<OpenAiAccount> {
  const ctx = new Context()
  contexts.push(ctx)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {})))
  const vault = new GrantVault('https://auth.openai.com/oauth/token', '/tmp/openai-account-test', memoryStore())
  await vault.prepare()
  const service = new OpenAiAccount(ctx, {}, vault)
  await ctx.plugin({ apply: () => undefined })
  return service
}

describe('ID token claims', () => {
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
      bodies.push(String(init.body))
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
})
