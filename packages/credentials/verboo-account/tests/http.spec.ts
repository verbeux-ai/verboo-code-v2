import { afterEach, expect, it, vi } from 'vitest'
import { deploymentOf } from '../src/config.ts'
import { operation, VerbooHttp } from '../src/http.ts'

const client = new VerbooHttp(deploymentOf({ apiOrigin: 'https://accounts.example.test' }))
const catalog = 'https://accounts.example.test/api/catalog'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function clocks() {
  const budget = new AbortController()
  const attempts: AbortController[] = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    if (ms === 35_000) return budget.signal
    const attempt = new AbortController()
    attempts.push(attempt)
    return attempt.signal
  })
  return { budget, attempts }
}

function retryAfter(value: string, status = 503): Response {
  return new Response(null, { status, headers: { 'Retry-After': value } })
}

it('honors seconds and HTTP dates with the same identity on every safe attempt', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-23T11:00:00Z'))
  clocks()
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(retryAfter('2', 429))
    .mockResolvedValueOnce(retryAfter(new Date(Date.now() + 5_000).toUTCString()))
    .mockResolvedValueOnce(Response.json({ models: [] }))
  vi.stubGlobal('fetch', fetch)
  const identity = operation()
  const pending = client.request(catalog, { headers: { 'X-Fixture': 'test' } }, identity)
  const result = expect(pending).resolves.toEqual({ models: [] })
  await vi.advanceTimersByTimeAsync(1_999)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2_999)
  expect(fetch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  await result
  expect(fetch).toHaveBeenCalledTimes(3)
  for (const [url, init] of fetch.mock.calls) {
    expect(url).toBe(catalog)
    expect(init?.redirect).toBe('error')
    const headers = new Headers(init?.headers)
    expect(headers.get('X-Fixture')).toBe('test')
    expect(headers.get('X-Verboo-Journey-Id')).toBe(identity.journeyId)
    expect(headers.get('X-Verboo-Operation-Id')).toBe(identity.operationId)
    expect(headers.get('X-Request-Id')).toBe(identity.requestId)
  }
})

it.each(['timeout', 'cancelled'] as const)('discriminates %s while waiting for Retry-After', async (reason) => {
  vi.useFakeTimers()
  const { budget } = clocks()
  const caller = new AbortController()
  const fetch = vi.fn(async () => retryAfter('60'))
  vi.stubGlobal('fetch', fetch)
  const pending = client.request(catalog, { signal: caller.signal })
  const rejected = expect(pending).rejects.toMatchObject({ code: `request_${reason}` })
  await vi.advanceTimersByTimeAsync(0)
  if (reason === 'timeout') budget.abort()
  else caller.abort()
  await rejected
  expect(fetch).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('never retries early for a Retry-After above the maximum timer delay', async () => {
  vi.useFakeTimers()
  const { budget } = clocks()
  const fetch = vi.fn(async () => retryAfter('864000000'))
  vi.stubGlobal('fetch', fetch)
  const pending = client.request(catalog)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'request_timeout' })
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledOnce()
  budget.abort()
  await rejected
})

it.each(['GET', 'POST'] as const)('classifies a stalled %s response body using its attempt deadline', async (method) => {
  const { attempts } = clocks()
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async (_url, init) => {
    const signal = init!.signal!
    return new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => { controller.error(signal.reason) }, { once: true })
      },
    }))
  }).mockResolvedValueOnce(Response.json({ models: [] }))
  vi.stubGlobal('fetch', fetch)
  const pending = client.request(catalog, { method })
  const outcome = method === 'GET'
    ? expect(pending).resolves.toEqual({ models: [] })
    : expect(pending).rejects.toMatchObject({ code: 'request_timeout', status: 200 })
  attempts[0]!.abort(new DOMException('fixture deadline', 'TimeoutError'))
  await outcome
  expect(fetch).toHaveBeenCalledTimes(method === 'GET' ? 2 : 1)
})

it('retries a transport failure on a safe read and preserves the final access decision', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new TypeError('test network failure'))
    .mockResolvedValueOnce(new Response('private response', { status: 403 }))
  vi.stubGlobal('fetch', fetch)
  await expect(client.request(catalog, { method: 'HEAD' })).rejects.toMatchObject({
    code: 'authorization_denied', status: 403, message: 'Verboo Code: authorization_denied',
  })
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('classifies a failed write without retrying it', async () => {
  const fetch = vi.fn(async () => { throw new TypeError('test network failure') })
  vi.stubGlobal('fetch', fetch)
  await expect(client.request(catalog, { method: 'POST' })).rejects.toMatchObject({ code: 'network_error' })
  expect(fetch).toHaveBeenCalledOnce()
})

it.each([
  { retry: '2', cancelCaller: false },
  { retry: undefined, cancelCaller: false },
  { retry: undefined, cancelCaller: true },
])('stops retrying when cleanup reaches the deadline or cancellation (%j)', async ({ retry, cancelCaller }) => {
  const { budget } = clocks()
  const caller = new AbortController()
  const fetch = vi.fn(async () => new Response(new ReadableStream({
    cancel() { (cancelCaller ? caller : budget).abort() },
  }), { status: 503, headers: retry === undefined ? {} : { 'Retry-After': retry } }))
  vi.stubGlobal('fetch', fetch)
  await expect(client.request(catalog, { signal: caller.signal })).rejects.toMatchObject({
    code: cancelCaller ? 'request_cancelled' : 'request_timeout',
  })
  expect(fetch).toHaveBeenCalledOnce()
})

it('classifies malformed successful JSON as a contract error without retrying', async () => {
  const fetch = vi.fn(async () => new Response('invalid json'))
  vi.stubGlobal('fetch', fetch)
  await expect(client.request(catalog)).rejects.toMatchObject({ code: 'contract_error', status: 200 })
  expect(fetch).toHaveBeenCalledOnce()
})
