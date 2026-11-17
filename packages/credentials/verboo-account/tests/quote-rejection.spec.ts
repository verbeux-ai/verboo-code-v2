/** Only an explicit server guarantee can release a purchase for a new quote. */
import { expect, it, vi } from 'vitest'
import { VerbooHttp } from '../src/http.ts'
import { Config, deploymentOf } from '../src/config.ts'

it.each([
  [409, true, 'quote_rejected'],
  [422, true, 'quote_rejected'],
  [409, false, 'unknown'],
  [500, true, 'unknown'],
] as const)('classifies HTTP %s with rejection marker %s without retaining response text', async (status, marker, code) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private-provider-message', {
    status, headers: marker ? { 'x-verboo-quote-rejected': 'true' } : {},
  })))
  try {
    const http = new VerbooHttp(deploymentOf(Config({})))
    await expect(http.request('https://code.verboo.ai/api/me/checkout/quotes', { method: 'POST' }))
      .rejects.toMatchObject({ code, status, message: `Verboo Code: ${code}` })
  } finally { vi.unstubAllGlobals() }
})
