/** The Verboo transport: retry policy, timeout budget, failure classification, and correlation identity. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountRequestError, observe, operation, VerbooHttp } from '../src/http.ts'
import type { Deployment } from '../src/config.ts'

/** A deployment double carrying only the fields the transport reads. */
function deployment(requestTimeoutMs = 10_000): Deployment {
  return { requestTimeoutMs, apiOrigin: 'https://api.example.com' } as unknown as Deployment
}

/** Response helpers. */
const json = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, ...(headers === undefined ? {} : { headers }) })
const empty = (status = 200): Response => new Response(null, { status })

/** Stub fetch with an instrumented handler. */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<unknown> | unknown): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    impl(input instanceof URL ? input.href : input instanceof Request ? input.url : input,
      { ...init, body: init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === 'string' ? init.body : '' })))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('operation', () => {
  it('mints three opaque identifiers per call', () => {
    const first = operation()
    expect(first.journeyId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.operationId).not.toBe(first.requestId)
    expect(operation().operationId).not.toBe(first.operationId)
  })
})

describe('observe', () => {
  it('emits one sanitized JSON line naming the stage, outcome, and error code', () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
    const context = { journeyId: 'j-1', operationId: 'o-1', requestId: 'r-1' }
    observe(context, 'login', 'failed', new AccountRequestError('network_error'))
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!.replace('[verboo-journey]', '')) as Record<string, unknown>
    expect(record).toMatchObject({
      schemaVersion: 2, journeyId: 'j-1', operationId: 'o-1', requestId: 'r-1',
      stage: 'login', outcome: 'failed', errorCode: 'network_error',
    })
    expect(lines[0]).not.toContain('token')
  })

  it('omits the error fields when the outcome carried none', () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')) })
    observe({ journeyId: 'j-2', operationId: 'o-2', requestId: 'r-2' }, 'catalog', 'succeeded')
    const record = JSON.parse(lines[0]!.replace('[verboo-journey]', '')) as Record<string, unknown>
    expect(record.errorCode).toBeUndefined()
    expect(record.httpStatus).toBeUndefined()
  })
})

describe('VerbooHttp', () => {
  it('sets the correlation headers from the operation identity', async () => {
    const http = new VerbooHttp(deployment())
    let headers: Headers | undefined
    stubFetch((_url, init) => { headers = new Headers(init.headers); return json({ ok: 1 }) })
    const context = { journeyId: 'j-1', operationId: 'o-1', requestId: 'r-1' }
    await http.request('https://api.example.com/x', {}, context)
    expect(headers!.get('X-Verboo-Journey-Id')).toBe('j-1')
    expect(headers!.get('X-Verboo-Operation-Id')).toBe('o-1')
    expect(headers!.get('X-Request-Id')).toBe('r-1')
  })

  it('returns null for a 204 and for a successful empty response when emptyResponse is set', async () => {
    const http = new VerbooHttp(deployment())
    stubFetch(() => empty(204))
    await expect(http.request('https://api.example.com/x')).resolves.toBeNull()
    stubFetch(() => empty())
    await expect(http.request('https://api.example.com/x', {}, undefined, true)).resolves.toBeNull()
  })

  it('throws contract_error when a successful body is not JSON', async () => {
    const http = new VerbooHttp(deployment())
    stubFetch(() => new Response('not json', { status: 200 }))
    await expect(http.request('https://api.example.com/x')).rejects.toMatchObject({ code: 'contract_error' })
  })

  it('classifies a non-ok response: 401 authentication_invalid, 403 authorization_denied, others unknown', async () => {
    const http = new VerbooHttp(deployment())
    for (const [status, code] of [[401, 'authentication_invalid'], [403, 'authorization_denied'], [500, 'unknown']] as const) {
      stubFetch(() => json({ error: 'nope' }, status))
      await expect(http.request('https://api.example.com/x')).rejects.toMatchObject({ code, status })
    }
  })

  it('recognizes an invalid_grant token error as authentication_invalid', async () => {
    const http = new VerbooHttp(deployment())
    stubFetch(() => json({ error: 'invalid_grant' }, 400))
    await expect(http.request('https://api.example.com/oauth/token')).rejects.toMatchObject({ code: 'authentication_invalid' })
  })

  it('reports a quote rejection the server marked before a financial write', async () => {
    const http = new VerbooHttp(deployment())
    stubFetch(() => json({ error: 'quote' }, 409, { 'x-verboo-quote-rejected': 'true' }))
    await expect(http.request('https://api.example.com/checkout')).rejects.toMatchObject({ code: 'quote_rejected', status: 409 })
  })

  it('classifies a hung fetch as a timeout when the per-request deadline fires', async () => {
    const http = new VerbooHttp(deployment(30))
    stubFetch((_url, init) => new Promise((_resolve, reject) => {
      // The composed signal is what a real fetch observes.
      init.signal?.addEventListener('abort', () => reject(new DOMException('deadline', 'TimeoutError')))
    }))
    await expect(http.request('https://api.example.com/checkout', { method: 'POST' }))
      .rejects.toMatchObject({ code: 'request_timeout' })
  })

  it('propagates a caller cancellation instead of retrying', async () => {
    const http = new VerbooHttp(deployment())
    const aborter = new AbortController()
    stubFetch(() => { throw new Error('never reached') })
    aborter.abort()
    await expect(http.request('https://api.example.com/x', { signal: aborter.signal }))
      .rejects.toMatchObject({ code: 'request_cancelled' })
  })

  it('classifies a deadline expiry as request_timeout', async () => {
    const http = new VerbooHttp(deployment(30))
    stubFetch(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new DOMException('deadline', 'TimeoutError')), 60)
    }))
    await expect(http.request('https://api.example.com/x')).rejects.toMatchObject({ code: 'request_timeout' })
  })

  it('retries safe reads on 503 and succeeds on the next attempt', async () => {
    const http = new VerbooHttp(deployment())
    let attempt = 0
    stubFetch(() => { attempt += 1; return attempt === 1 ? json({ error: 'down' }, 503) : json({ ok: 1 }) })
    await expect(http.request('https://api.example.com/x')).resolves.toEqual({ ok: 1 })
    expect(attempt).toBe(2)
  })

  it('fails after the retry budget on repeated 503 reads', async () => {
    const http = new VerbooHttp(deployment())
    stubFetch(() => json({ error: 'down' }, 503))
    await expect(http.request('https://api.example.com/x')).rejects.toMatchObject({ status: 503 })
  })

  it('honors a numeric retry-after header by waiting before the next read', async () => {
    const http = new VerbooHttp(deployment())
    let attempt = 0
    stubFetch(() => { attempt += 1; return attempt === 1 ? json({ error: 'down' }, 503, { 'retry-after': '1' }) : json({ ok: 1 }) })
    await expect(http.request('https://api.example.com/x')).resolves.toEqual({ ok: 1 })
    expect(attempt).toBe(2)
  })

  it('aborts the retry wait when the caller cancels during it', async () => {
    const http = new VerbooHttp(deployment())
    const aborter = new AbortController()
    stubFetch(() => json({ error: 'down' }, 429, { 'retry-after': '1' }))
    const pending = http.request('https://api.example.com/x', { signal: aborter.signal })
    aborter.abort()
    await expect(pending).rejects.toMatchObject({ code: 'request_cancelled' })
  })

  it('treats a past-dated retry-after as an immediate retry', async () => {
    const http = new VerbooHttp(deployment())
    let attempt = 0
    stubFetch(() => {
      attempt += 1
      return attempt === 1
        ? json({ error: 'down' }, 503, { 'retry-after': new Date(Date.now() - 60_000).toUTCString() })
        : json({ ok: 1 })
    })
    await expect(http.request('https://api.example.com/x')).resolves.toEqual({ ok: 1 })
    expect(attempt).toBe(2)
  })

  it('parses a date-form retry-after and waits the remaining time', async () => {
    const http = new VerbooHttp(deployment())
    let attempt = 0
    stubFetch(() => {
      attempt += 1
      return attempt === 1
        ? json({ error: 'down' }, 503, { 'retry-after': new Date(Date.now() - 1_000).toUTCString() })
        : json({ ok: 1 })
    })
    await expect(http.request('https://api.example.com/x')).resolves.toEqual({ ok: 1 })
    expect(attempt).toBe(2)
  })
})

describe('VerbooHttp network failures', () => {
  it('classifies a plain fetch rejection as network_error', async () => {
    const http = new VerbooHttp(deployment())
    stubFetch(() => { throw new Error('socket down') })
    await expect(http.request('https://api.example.com/x'))
      .rejects.toMatchObject({ code: 'network_error' })
  })

  it('retries a failed safe read and classifies the final failure as network_error', async () => {
    const http = new VerbooHttp(deployment())
    stubFetch(() => { throw new Error('socket down') })
    await expect(http.request('https://api.example.com/x'))
      .rejects.toMatchObject({ code: 'network_error' })
  })
})
