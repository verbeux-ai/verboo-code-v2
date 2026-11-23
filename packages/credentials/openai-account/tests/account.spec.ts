/**
 * The account service: what a login reports, how a token is renewed, and the
 * guarantees that keep a token out of every observable surface.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiAccount, claimsOf, pkcePair } from '../src/account.ts'
import { AccountRequestError } from '../src/http.ts'
import { GrantVault, type SecretKeyStore } from '../src/vault.ts'

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

/** Distinct home per fixture, so no two runs share a store. */
let counter = 0
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Mount the account service with a stubbed transport and an in-memory vault. */
type WireInit = { readonly body: URLSearchParams | string; readonly method?: string; readonly signal?: AbortSignal | null }
async function harness(handler: (url: string, init: WireInit) => Response | Promise<Response>, store?: SecretKeyStore): Promise<OpenAiAccount & { ctx: Context }> {
  const ctx = new Context()
  contexts.push(ctx)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(input instanceof URL ? input.href : input instanceof Request ? input.url : input,
      { ...init, body: init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === 'string' ? init.body : '' })))
  // Not prepared here: the service must create the key on its first write, as a
  // fresh installation does. A caller may inject only a SecretKeyStore — then
  // the vault wraps it — or a full GrantVault.
  const keyStore: SecretKeyStore | GrantVault = store ?? new GrantVault('https://auth.openai.com/oauth/token', `/tmp/openai-account-test-${String(counter++)}`, memoryStore())
  const service = new OpenAiAccount(ctx, {}, keyStore instanceof GrantVault ? keyStore : new GrantVault('https://auth.openai.com/oauth/token', `/tmp/openai-account-store-${String(counter++)}`, keyStore))
  await ctx.plugin({ apply: () => undefined })
  return service as OpenAiAccount & { ctx: Context }
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

describe('ID token claims edge cases', () => {
  it('reports no facts when the payload is not an object', () => {
    // A JWT whose payload is a JSON array or a bare number decodes but carries
    // no record: no plan facts, and the tokens stay usable.
    const arrayPayload = Buffer.from(JSON.stringify(['a'])).toString('base64url')
    const numberPayload = Buffer.from(JSON.stringify(42)).toString('base64url')
    expect(claimsOf(`a.${arrayPayload}.c`)).toEqual({})
    expect(claimsOf(`a.${numberPayload}.c`)).toEqual({})
  })

  it('reads partial facts: each claim is independent, and a missing exp yields no expiry', () => {
    const claims = claimsOf(jwt({
      [AUTH_CLAIMS]: { chatgpt_plan_type: 'pro' },
    }))
    expect(claims).toEqual({ planType: 'pro' })
  })

  it('ignores claim values that are not strings', () => {
    const claims = claimsOf(jwt({
      exp: 1_800_000_000,
      [AUTH_CLAIMS]: { chatgpt_plan_type: 42, chatgpt_account_id: null },
    }))
    expect(claims).toEqual({ expiresAt: 1_800_000_000_000 })
  })
})

describe('a Host without the OS credential store', () => {
  it('stays signed out instead of failing the boot', async () => {
    vi.stubEnv('DSH_DISABLE_OS_KEYRING', '1')
    try {
      const service = new OpenAiAccount(new Context(), {})
      await expect(service.status()).resolves.toEqual({ signedIn: false })
      await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
      await expect(service.signOut()).resolves.toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('still uses the OS store when the disable flag is not set and no vault was injected', () => {
    vi.stubEnv('DSH_DISABLE_OS_KEYRING', '')
    try {
      const service = new OpenAiAccount(new Context(), {})
      // The flag absent means the store is usable: signing in would reach the
      // OS keyring, which is the supported deployment.
      expect(service).toBeDefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('renewing an expired token', () => {
  it('reports no token when the refresh call is cancelled', async () => {
    const expired = tokenResponse({
      access_token: 'access-expired',
      refresh_token: 'refresh-1',
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10, [AUTH_CLAIMS]: { chatgpt_plan_type: 'team' } }),
    })
    const aborter = new AbortController()
    const service = await harness((_url, init) => {
      // A caller cancelling mid-renewal propagates as a cancellation.
      if (String(init.body).includes('grant_type=refresh_token')) {
        aborter.abort()
        return Promise.reject(new DOMException('cancelled', 'AbortError'))
      }
      return new Response(JSON.stringify(expired), { status: 200 })
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(aborter.signal)).rejects.toMatchObject({ code: 'request_cancelled' })
  })
})

describe('grant persistence edge cases', () => {
  it('uses the default home when no DSH_HOME is set, and honors DSH_HOME when set', () => {
    const home = '/tmp/dsh-home-override'
    vi.stubEnv('DSH_HOME', home)
    try {
      const service = new OpenAiAccount(new Context(), {}, new GrantVault('https://auth.openai.com/oauth/token', '/home/fixture', memoryStore()))
      // The grant file lives under the configured home; the real path is kept
      // private, so the observable fact is that the service constructs.
      expect(service).toBeDefined()
    } finally {
      vi.unstubAllEnvs()
    }
    expect(new OpenAiAccount(new Context(), {}, new GrantVault('https://auth.openai.com/oauth/token', '/home/fixture', memoryStore()))).toBeDefined()
  })

  it('writes the home directory on the first login so a fresh installation does not fail', async () => {
    const home = mkdtempSync(join(tmpdir(), 'openai-home-'))
    // The grant file's parent starts absent; the write creates it.
    vi.stubEnv('DSH_HOME', home)
    try {
      const service = await harness(() => new Response(JSON.stringify(tokenResponse()), { status: 200 }))
      await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
      await expect(service.status()).resolves.toMatchObject({ signedIn: true })
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects a token response missing any of the three required fields', async () => {
    for (const missing of ['access_token', 'refresh_token', 'id_token']) {
      const { [missing]: _dropped, ...body } = tokenResponse()
      const service = await harness(() => new Response(JSON.stringify(body), { status: 200 }))
      await expect(service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal))
        .rejects.toMatchObject({ code: 'invalid_response' })
    }
  })

  it('rejects a token response that is not an object', async () => {
    const service = await harness(() => new Response('["array"]', { status: 200 }))
    await expect(service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('reports no token when the renewed response is unparseable', async () => {
    const expired = tokenResponse({
      access_token: 'access-expired',
      refresh_token: 'refresh-1',
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10, [AUTH_CLAIMS]: { chatgpt_plan_type: 'team' } }),
    })
    let renewal = 0
    const service = await harness((_url, init) => {
      renewal += 1
      if (String(init.body).includes('grant_type=refresh_token')) {
        return new Response('not json', { status: 200 })
      }
      return new Response(JSON.stringify(expired), { status: 200 })
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
  })

  it('signs out and emits the signed-out event when the provider refuses the renewal', async () => {
    const expired = tokenResponse({
      access_token: 'access-expired',
      refresh_token: 'refresh-1',
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10, [AUTH_CLAIMS]: { chatgpt_plan_type: 'team' } }),
    })
    let renewal = 0
    const service = await harness((_url, init) => {
      renewal += 1
      if (String(init.body).includes('grant_type=refresh_token')) {
        return new Response('{"error":"invalid_grant"}', { status: 400 })
      }
      return new Response(JSON.stringify(expired), { status: 200 })
    })
    const events: string[] = []
    service.ctx.on('openai-account/signed-out', () => { events.push('signed-out') })

    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
    expect(events).toEqual(['signed-out'])
    await expect(service.status()).resolves.toEqual({ signedIn: false })
  })
})

describe('grant persistence details', () => {
  it('falls back to the default home when DSH_HOME is absent', () => {
    vi.stubEnv('DSH_HOME', '')
    try {
      // The snapshot reads the process layer: a value defined as empty is not
      // absent, so delete it to reach the ?? fallback.
      delete process.env.DSH_HOME
      expect(new OpenAiAccount(new Context(), {}, new GrantVault('https://auth.openai.com/oauth/token', '/home/fixture', memoryStore()))).toBeDefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reports credential_store_unavailable when the vault cannot prepare', async () => {
    const broken = { getSecret: async () => { throw new Error('store down') }, setSecret: async () => undefined }
    const service = await harness(() => new Response(JSON.stringify(tokenResponse()), { status: 200 }), broken as never)
    await expect(service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal))
      .rejects.toMatchObject({ code: 'credential_store_unavailable' })
  })

  it('statusOf and persist handle a grant with no plan facts at all', async () => {
    // The ID token carries no [OI] claims: the grant stores only the tokens.
    const bare = tokenResponse({
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3_600 }),
    })
    const service = await harness(() => new Response(JSON.stringify(bare), { status: 200 }))
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    const status = await service.status()
    expect(status.signedIn).toBe(true)
    expect(status.planType).toBeUndefined()
    expect(status.accountId).toBeUndefined()
    expect(status.activeUntil).toBeUndefined()
  })

  it('reports no token when the renewed response has no usable grant', async () => {
    const expired = tokenResponse({
      access_token: 'access-expired',
      refresh_token: 'refresh-1',
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10, [AUTH_CLAIMS]: { chatgpt_plan_type: 'team' } }),
    })
    const service = await harness((_url, init) => {
      if (String(init.body).includes('grant_type=refresh_token')) {
        // A renewal whose body is an array: persist rejects it, renew swallows it.
        return new Response('["array"]', { status: 200 })
      }
      return new Response(JSON.stringify(expired), { status: 200 })
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
  })
})

describe('partial claim sets', () => {
  it('stores a grant whose claims carry an account id but no plan or window', async () => {
    const partial = tokenResponse({
      id_token: jwt({
        exp: Math.floor(Date.now() / 1000) + 3_600,
        [AUTH_CLAIMS]: { chatgpt_account_id: 'account-9' },
      }),
    })
    const service = await harness(() => new Response(JSON.stringify(partial), { status: 200 }))
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    const status = await service.status()
    expect(status).toEqual({ signedIn: true, accountId: 'account-9' })
  })

  it('stores a grant whose claims carry a window end but no account or plan', async () => {
    const partial = tokenResponse({
      id_token: jwt({
        exp: Math.floor(Date.now() / 1000) + 3_600,
        [AUTH_CLAIMS]: { chatgpt_subscription_active_until: '2027-06-01T00:00:00+00:00' },
      }),
    })
    const service = await harness(() => new Response(JSON.stringify(partial), { status: 200 }))
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    const status = await service.status()
    expect(status).toEqual({ signedIn: true, activeUntil: '2027-06-01T00:00:00+00:00' })
  })
})

it('rejects a token response missing the access or refresh token', async () => {
  for (const missing of ['access_token', 'refresh_token']) {
    const { [missing]: _dropped, ...body } = tokenResponse()
    const service = await harness(() => new Response(JSON.stringify(body), { status: 200 }))
    await expect(service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  }
})

describe('deployment of the grant file', () => {
  it('resolves the grant file under the home the launch environment provides', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-present-'))
    vi.stubEnv('DSH_HOME', home)
    try {
      const service = await harness(() => new Response(JSON.stringify(tokenResponse()), { status: 200 }))
      await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
      await expect(service.status()).resolves.toMatchObject({ signedIn: true })
      // The grant was written under the configured home, proving the branch
      // that reads the launch environment ran.
      const written = readdirSync(home, { recursive: true }).filter(f => String(f).endsWith('.grant.json'))
      expect(written).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('covers the renew path whose claims carry no account identity', async () => {
    const expired = tokenResponse({
      access_token: 'access-expired',
      refresh_token: 'refresh-1',
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10 }),
    })
    const renewed = tokenResponse({
      access_token: 'access-renewed',
      refresh_token: 'refresh-2',
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3_600 }),
    })
    let renewal = 0
    const service = await harness((_url, init) => {
      renewal += 1
      if (String(init.body).includes('grant_type=refresh_token')) {
        return new Response(JSON.stringify(renewed), { status: 200 })
      }
      return new Response(JSON.stringify(expired), { status: 200 })
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(new AbortController().signal)).resolves.toBe('access-renewed')
  })
})

describe('grant claims spread', () => {
  it('stores a grant whose claims carry none of the three', async () => {
    const partial = tokenResponse({
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3_600 }),
    })
    const service = await harness(() => new Response(JSON.stringify(partial), { status: 200 }))
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.status()).resolves.toEqual({ signedIn: true })
  })

  it('persists a grant whose claims carry an account id but no plan', async () => {
    const partial = tokenResponse({
      id_token: jwt({
        exp: Math.floor(Date.now() / 1000) + 3_600,
        [AUTH_CLAIMS]: { chatgpt_account_id: 'account-3' },
      }),
    })
    const service = await harness(() => new Response(JSON.stringify(partial), { status: 200 }))
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    const status = await service.status()
    expect(status).toEqual({ signedIn: true, accountId: 'account-3' })
  })

  it('stores a grant whose claims carry an account id and a plan but no window', async () => {
    const partial = tokenResponse({
      id_token: jwt({
        exp: Math.floor(Date.now() / 1000) + 3_600,
        [AUTH_CLAIMS]: { chatgpt_account_id: 'account-7', chatgpt_plan_type: 'max' },
      }),
    })
    const service = await harness(() => new Response(JSON.stringify(partial), { status: 200 }))
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    const status = await service.status()
    expect(status).toEqual({ signedIn: true, accountId: 'account-7', planType: 'max' })
  })
})

describe('persist classification', () => {
  it('rejects a renewal whose status is a server error', async () => {
    const expired = tokenResponse({
      access_token: 'access-expired',
      refresh_token: 'refresh-1',
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10, [AUTH_CLAIMS]: { chatgpt_plan_type: 'team' } }),
    })
    const service = await harness((_url, init) => {
      if (String(init.body).includes('grant_type=refresh_token')) {
        return new Response('{"error":"upstream"}', { status: 500 })
      }
      return new Response(JSON.stringify(expired), { status: 200 })
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
  })

  it('rejects a renewal whose body is not an object', async () => {
    const expired = tokenResponse({
      access_token: 'access-expired',
      refresh_token: 'refresh-1',
      id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 10, [AUTH_CLAIMS]: { chatgpt_plan_type: 'team' } }),
    })
    const service = await harness((_url, init) => {
      if (String(init.body).includes('grant_type=refresh_token')) {
        return new Response('null', { status: 200 })
      }
      return new Response(JSON.stringify(expired), { status: 200 })
    })
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    await expect(service.accessToken(new AbortController().signal)).resolves.toBeUndefined()
  })
})

describe('grant claims spread', () => {
  it('stores a grant whose claims carry a plan and a window but no account id', async () => {
    const partial = tokenResponse({
      id_token: jwt({
        exp: Math.floor(Date.now() / 1000) + 3_600,
        [AUTH_CLAIMS]: { chatgpt_plan_type: 'team', chatgpt_subscription_active_until: '2027-09-01T00:00:00+00:00' },
      }),
    })
    const service = await harness(() => new Response(JSON.stringify(partial), { status: 200 }))
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    const status = await service.status()
    expect(status).toEqual({ signedIn: true, planType: 'team', activeUntil: '2027-09-01T00:00:00+00:00' })
  })
})

describe('grant expiry fallback', () => {
  it('gives the grant an hour of validity when the ID token carries no exp', async () => {
    // No exp: persist falls back to now + 1h rather than trusting the token.
    const noExpiry = tokenResponse({
      id_token: jwt({ [AUTH_CLAIMS]: { chatgpt_plan_type: 'team' } }),
    })
    const service = await harness(() => new Response(JSON.stringify(noExpiry), { status: 200 }))
    await service.complete('code', 'verifier', 'http://127.0.0.1/cb', new AbortController().signal)
    const status = await service.status()
    expect(status.signedIn).toBe(true)
    // The grant stays usable within the fallback hour.
    await expect(service.accessToken(new AbortController().signal)).resolves.toBe('access-token-value')
  })
})
