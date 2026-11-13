/** The backend read, its headers, and the readings each source supports. */
import { afterEach, expect, it, vi } from 'vitest'
import { accountIdFromToken, readUsage, usageOf } from '../src/usage.ts'
import { BASE_URL, USAGE_PATH } from '../src/config.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A JWT-shaped fixture token carrying the account claim the backend reads. */
function tokenFor(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`
}

/** Answer the usage endpoint with one status, body, and headers, recording the request. */
function endpoint(status: number, body: string, headers: Record<string, string> = {}) {
  const requests: Array<{ url: string; headers: Headers }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push({ url: url.href, headers: new Headers(init?.headers) })
    return new Response(body, { status, headers })
  })
  return requests
}

it('reads the documented endpoint with the account credential', async () => {
  const requests = endpoint(200, JSON.stringify({ used_percent: 20 }))
  const reading = await readUsage({ accessToken: tokenFor('acct-3'), timeoutMs: 1_000 })
  expect(requests[0]?.url).toBe(`${BASE_URL}${USAGE_PATH}`)
  expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${tokenFor('acct-3')}`)
  expect(requests[0]?.headers.get('chatgpt-account-id')).toBe('acct-3')
  expect(reading).toMatchObject({ usedPercent: 20, unlimited: false })
})

it('accepts an explicit account identifier and a caller signal', async () => {
  const requests = endpoint(200, JSON.stringify({ used_percent: 5 }))
  const controller = new AbortController()
  const reading = await readUsage({
    accessToken: 'opaque-token',
    accountId: 'acct-4',
    timeoutMs: 1_000,
    signal: controller.signal,
  })
  expect(requests[0]?.headers.get('chatgpt-account-id')).toBe('acct-4')
  expect(reading).toMatchObject({ usedPercent: 5 })
})

it('sends no account header when neither the token nor the caller names one', async () => {
  const requests = endpoint(200, JSON.stringify({ used_percent: 5 }))
  await readUsage({ accessToken: 'opaque-token', timeoutMs: 1_000 })
  expect(requests[0]?.headers.get('chatgpt-account-id')).toBeNull()
})

it('reports no reading when the endpoint refuses, keeping only its headers', async () => {
  endpoint(429, 'refused', { 'x-codex-active-limit': 'workspace_member_usage_limit_reached' })
  expect(await readUsage({ accessToken: tokenFor('acct-5'), timeoutMs: 1_000 })).toBeUndefined()

  endpoint(429, JSON.stringify({ used_percent: 99 }), { 'x-codex-credits-unlimited': 'true' })
  expect(await readUsage({ accessToken: tokenFor('acct-5'), timeoutMs: 1_000 })).toMatchObject({
    usedPercent: 99,
    unlimited: true,
  })
})

it('reports no reading when the body is not JSON', async () => {
  endpoint(200, 'not json')
  expect(await readUsage({ accessToken: tokenFor('acct-6'), timeoutMs: 1_000 })).toBeUndefined()
})

it('reads the credit balance from the header when the document omits it', () => {
  expect(usageOf({
    asOf: '2026-11-13T00:00:00.000Z',
    headers: { 'x-codex-credits-balance': '7' },
    body: { used_percent: 30, credits: { has_credits: true } },
  })).toMatchObject({ usedPercent: 30, credits: 7 })
})

it('accepts the flattened camel-case spelling of a compatible deployment', () => {
  expect(usageOf({
    asOf: '2026-11-13T00:00:00.000Z',
    body: {
      usedPercent: 44,
      windowSeconds: 3_600,
      resetAfterSeconds: 30,
      planType: 'pro',
      activeUntil: '2027-01-01T00:00:00.000Z',
    },
  })).toMatchObject({
    usedPercent: 44,
    windowSeconds: 3_600,
    resetAfterSeconds: 30,
    planType: 'pro',
    activeUntil: '2027-01-01T00:00:00.000Z',
  })
})

it('omits the plan and window facts the provider did not disclose', () => {
  const reading = usageOf({ asOf: '2026-11-13T00:00:00.000Z', body: { used_percent: 1 } })
  expect(reading).toEqual({ usedPercent: 1, unlimited: false, asOf: '2026-11-13T00:00:00.000Z' })
})

it('rejects a token whose payload is not a claims object', () => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  expect(accountIdFromToken(`${encode({})}.${encode('just-a-string')}.sig`)).toBeUndefined()
  expect(accountIdFromToken(`${encode({})}.${encode(null)}.sig`)).toBeUndefined()
})

it('ignores a credit balance header that is not a number', () => {
  expect(usageOf({
    asOf: '2026-11-13T00:00:00.000Z',
    headers: { 'x-codex-credits-balance': 'plenty' },
    body: { used_percent: 2 },
  })).not.toHaveProperty('credits')
})

it('numbers an additional limit the provider left unidentified and skips one with no window', () => {
  expect(usageOf({
    asOf: '2026-11-13T00:00:00.000Z',
    body: {
      used_percent: 10,
      additional_rate_limits: [
        { used_percent: 4 },
        { id: 'no-window' },
        { name: 'named', used_percent: 6 },
        { meter: 'metered', used_percent: 7 },
      ],
    },
  })?.additionalLimits).toEqual([
    { id: '1', usedPercent: 4 },
    { id: 'named', usedPercent: 6 },
    { id: 'metered', usedPercent: 7 },
  ])
})
