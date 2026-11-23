/** The plugin mounting, the deployment validation, and the transport's failure paths. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, name, inject, deploymentOf } from '../src/index.ts'
import { Config } from '../src/config.ts'
import { AccountHttp, operation } from '../src/http.ts'

describe('plugin mounting', () => {
  it('declares the plugin name and the credentials injection', () => {
    expect(name).toBe('openai-account')
    expect(inject).toEqual(['credentials'])
  })

  it('apply mounts the account service and the sign-in surface without throwing', () => {
    const ctx = new Context()
    expect(() =>{  apply(ctx, {}) }).not.toThrow()
  })
})

describe('deploymentOf', () => {
  it('resolves the default deployment when the config is empty', () => {
    const deployment = deploymentOf()
    expect(deployment.authorizeUrl).toMatch(/^https:\/\//)
    expect(deployment.tokenUrl).toMatch(/^https:\/\//)
    expect(deployment.revokeUrl).toMatch(/^https:\/\//)
    expect(deployment.clientId.length).toBeGreaterThan(0)
    expect(deployment.scopes).toContain('openid')
    expect(deployment.scopes).toContain('offline_access')
  })

  it('rejects a non-absolute endpoint', () => {
    expect(() => deploymentOf(Config({ authorizeUrl: 'auth.example.com/oauth' })))
      .toThrow('authorizeUrl is not an absolute URL')
  })

  it('rejects an endpoint with credentials, a query, or a fragment', () => {
    expect(() => deploymentOf(Config({ tokenUrl: 'https://u:p@auth.example.com/token' })))
      .toThrow('not an allowed OAuth endpoint')
    expect(() => deploymentOf(Config({ tokenUrl: 'https://auth.example.com/token?x=1' })))
      .toThrow('not an allowed OAuth endpoint')
    expect(() => deploymentOf(Config({ tokenUrl: 'https://auth.example.com/token#frag' })))
      .toThrow('not an allowed OAuth endpoint')
  })

  it('rejects plain http unless the endpoint is loopback and loopback http is allowed', () => {
    expect(() => deploymentOf(Config({ tokenUrl: 'http://auth.example.com/token' })))
      .toThrow('not an allowed OAuth endpoint')
    expect(deploymentOf(Config({ tokenUrl: 'http://127.0.0.1/token', allowLoopbackHttp: true })).tokenUrl)
      .toBe('http://127.0.0.1/token')
    expect(() => deploymentOf(Config({ tokenUrl: 'http://127.0.0.1/token' })))
      .toThrow('not an allowed OAuth endpoint')
  })

  it('rejects empty, blank, or missing required scopes', () => {
    expect(() => deploymentOf(Config({ scopes: [] }))).toThrow('non-empty list')
    expect(() => deploymentOf(Config({ scopes: ['   '] }))).toThrow('non-empty list')
    expect(() => deploymentOf(Config({ scopes: ['openid'] }))).toThrow('must include')
  })

  it('rejects a blank clientId', () => {
    expect(() => deploymentOf(Config({ clientId: '   ' }))).toThrow('clientId must not be blank')
  })
})

describe('AccountHttp failure paths', () => {
  /** A response whose body the reader rejects. */
  function stubFetch(impl: (url: string, init: RequestInit) => Promise<unknown>): void {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      impl(input instanceof URL ? input.href : input instanceof Request ? input.url : input,
        { ...init, body: init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === 'string' ? init.body : '' })))
  }

  it('reports a network failure as network_error and a deadline as request_timeout', async () => {
    const http = new AccountHttp(10)
    const operation = { signal: new AbortController().signal }
    stubFetch(async () => { throw new Error('socket down') })
    await expect(http.json('https://auth.example.com/token', { method: 'POST' }, operation as never))
      .rejects.toMatchObject({ code: 'network_error' })
    // A deadline that expires before the response is a timeout, not a network failure.
    const late = new AccountHttp(10)
    const aborter = new AbortController()
    stubFetch((_url: string, init: RequestInit) => new Promise((_resolve, reject: (reason?: unknown) => void) => {
      init?.signal?.addEventListener('abort', () =>{  reject(new DOMException('timeout', 'TimeoutError')) })
    }))
    await expect(late.json('https://auth.example.com/token', { method: 'POST' }, { signal: aborter.signal }))
      .rejects.toMatchObject({ code: 'request_timeout' })
  })

  it('reports caller cancellation as request_cancelled', async () => {
    const http = new AccountHttp(5000)
    const aborter = new AbortController()
    stubFetch((_url: string, init: RequestInit) => new Promise((_resolve, reject: (reason?: unknown) => void) => {
      // A signal aborted before the call never fires its listener again.
      if (init?.signal?.aborted) { reject(new DOMException('cancelled', 'AbortError')); return }
      init?.signal?.addEventListener('abort', () =>{  reject(new DOMException('cancelled', 'AbortError')) })
    }))
    aborter.abort()
    await expect(http.json('https://auth.example.com/token', { method: 'POST' }, { signal: aborter.signal }))
      .rejects.toMatchObject({ code: 'request_cancelled' })
  })

  it('returns undefined for an empty success body and throws invalid_response for unparseable JSON', async () => {
    const http = new AccountHttp(5000)
    const operation = { signal: new AbortController().signal }
    stubFetch(async () => new Response('', { status: 200 }))
    await expect(http.json('https://auth.example.com/token', {}, operation as never))
      .resolves.toEqual({ status: 200, body: undefined })
    stubFetch(async () => new Response('not json', { status: 200 }))
    await expect(http.json('https://auth.example.com/token', {}, operation as never))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('operation helper', () => {
  it('wraps the caller signal as the operation the HTTP helper consumes', () => {
    const signal = new AbortController().signal
    expect(operation(signal)).toEqual({ signal })

  })
})
