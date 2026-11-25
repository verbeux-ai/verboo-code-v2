import { afterEach, describe, expect, it, vi } from 'vitest'
import { deploymentOf } from '../src/config.ts'
import { VerbooHttp } from '../src/http.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('response body diagnostics', () => {
  const http = new VerbooHttp(deploymentOf({}))

  it('preserves caller cancellation after response headers', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => new Response(new ReadableStream({
      start(body) {
        init.signal?.addEventListener('abort', () => { body.error(new Error('aborted')) }, { once: true })
      },
    })))
    const pending = http.request('https://code.verboo.ai/test', { method: 'POST', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'request_cancelled' })
  })

  it('distinguishes malformed JSON from an interrupted body', async () => {
    vi.stubGlobal('fetch', async () => new Response('{'))
    await expect(http.request('https://code.verboo.ai/test')).rejects.toMatchObject({ code: 'contract_error' })
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
      start(body) { body.error(new Error('connection reset')) },
    })))
    await expect(http.request('https://code.verboo.ai/test')).rejects.toMatchObject({ code: 'network_error' })
  })
})
