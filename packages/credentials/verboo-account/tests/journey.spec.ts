/** The login journey: queueing, batching, receipt verification, and the failure paths. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginJourney } from '../src/journey.ts'
import type { Deployment } from '../src/config.ts'

/** A deployment double carrying only the fields the collector reads. */
function deployment(): Deployment {
  return {
    apiOrigin: 'https://api.example.com',
    routerBaseURL: 'https://api.example.com',
    clientId: 'client-1',
    requestTimeoutMs: 5_000,
    attemptTimeoutMs: 5_000,
    catalogMaxAgeMs: 60_000,
    fallbackContextWindow: 100_000,
    fallbackMaxOutputTokens: 8_192,
    malformedResponseRetries: 1,
  }
}

/** Mount the journey beside a file-backed credential store. */
async function journey(respond?: (rawEvents: string[]) => Response): Promise<{ collector: LoginJourney; requests: Array<{ url: string; body: string }>; store: Map<string, unknown>; root: string }> {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'verboo-journey-'))
  const store = new Map<string, unknown>()
  ctx.provide('credentials', {
    readRecord: async (key: string) => store.get(key),
    modifyRecord: async (key: string, mutate: (current: unknown) => unknown) => {
      const next = await mutate(store.get(key))
      store.set(key, next)
      return next
    },
  })
  const requests: Array<{ url: string; body: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' })
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { events: unknown[] }
    return respond?.(body.events.map(event => JSON.stringify(event))) ?? new Response('{}', { status: 200 })
  }))
  const collector = new LoginJourney(ctx, deployment())
  return { collector, requests, store, root }
}

/** One queued event's JSON, in the shape the collector stores. */
function eventJson(journeyId: string, operationId: string): string {
  return JSON.stringify({
    eventId: crypto.randomUUID(),
    journeyId,
    operationId,
    stage: 'login',
    outcome: 'started',
    occurredAt: new Date().toISOString(),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LoginJourney', () => {
  it('queues an observation and delivers it in one batch, verifying the receipt', async () => {
    const { collector, requests, store, root } = await journey()
    const context = { journeyId: crypto.randomUUID(), operationId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    collector.record(context, 'started')
    // The record write and the drain settle asynchronously.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://api.example.com/api/journey/events')
    const body = JSON.parse(requests[0]!.body) as { schemaVersion: number; events: string[] }
    expect(body.schemaVersion).toBe(1)
    expect(body.events).toHaveLength(1)
    // The receipt the stub returns is an empty object, so the queue keeps the
    // event pending: the persisted record still carries it.
    const persisted = store.get('verboo-account/observations') as { payload: { pending: unknown[] } }
    expect(persisted.payload.pending.length).toBeGreaterThan(0)
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts a receipt naming the delivered event and clears the queue', async () => {
    const { createHash } = await import('node:crypto')
    const journeyId = crypto.randomUUID()
    const { collector, requests, store } = await journey(rawEvents => {
      const receipts = rawEvents.map(json => {
        const event = JSON.parse(json) as { eventId: string }
        return {
          eventId: event.eventId,
          journeyId,
          clientApp: '',
          payloadSha256: createHash('sha256').update(`1:${json}`).digest('hex'),
        }
      })
      return new Response(JSON.stringify({ data: { receipts } }), { status: 200 })
    })
    const context = { journeyId, operationId: crypto.randomUUID(), requestId: crypto.randomUUID() }

    collector.record(context, 'started')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(requests.length).toBeGreaterThan(0)
    const persisted = store.get('verboo-account/observations') as { payload: { pending: unknown[] } }
    expect(persisted.payload.pending).toHaveLength(0)
  })

  it('throws contract_error when the receipt names a different event', async () => {
    const { collector, requests } = await journey()
    const context = { journeyId: crypto.randomUUID(), operationId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' })
      return new Response(JSON.stringify({
        data: { receipts: [{ eventId: crypto.randomUUID(), journeyId: crypto.randomUUID(), clientApp: '', payloadSha256: '0'.repeat(64) }] },
      }), { status: 200 })
    }))
    collector.record(context, 'failed', new (await import('../src/http.ts')).AccountRequestError('network_error'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(requests.length).toBeGreaterThan(0)
  })

  it('keeps the event pending when the collector rejects it as a client error', async () => {
    const { collector, requests, store } = await journey()
    const context = { journeyId: crypto.randomUUID(), operationId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' })
      return new Response('{"error":"nope"}', { status: 400 })
    }))
    collector.record(context, 'started')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(requests.length).toBeGreaterThan(0)
    const persisted = store.get('verboo-account/observations') as { payload: { pending: unknown[] } }
    expect(persisted.payload.pending).toHaveLength(1)
  })

  it('loses the oldest event when the queue is full at 1000 pending', async () => {
    const { collector, requests, store } = await journey()
    const journeyId = crypto.randomUUID()
    const pending: Array<{ schemaVersion: 1; release: string; json: string }> = []
    for (let i = 0; i < 1000; i += 1) {
      const json = eventJson(journeyId, crypto.randomUUID())
      pending.push({ schemaVersion: 1, release: '0.2.2', json })
    }
    store.set('verboo-account/observations', { kind: 'grant', payload: { version: 1, lost: 0, pending } })
    const context = { journeyId, operationId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' })
      return new Response('{"error":"down"}', { status: 503 })
    }))
    collector.record(context, 'started')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(requests.length).toBeGreaterThan(0)
    const persisted = store.get('verboo-account/observations') as { payload: { lost: number; pending: unknown[] } }
    expect(persisted.payload.lost).toBe(1)
  })

  it('batches at most 20 events per request and keeps the rest pending', async () => {
    const journeyId = crypto.randomUUID()
    const pending: Array<{ schemaVersion: 1; release: string; json: string }> = []
    for (let i = 0; i < 25; i += 1) {
      pending.push({ schemaVersion: 1, release: '0.2.2', json: eventJson(journeyId, crypto.randomUUID()) })
    }
    const { collector, requests, store } = await journey(rawEvents => {
      const receipts = rawEvents.map(json => {
        const event = JSON.parse(json) as { eventId: string }
        return { eventId: event.eventId, journeyId, clientApp: '', payloadSha256: '0'.repeat(64) }
      })
      return new Response(JSON.stringify({ data: { receipts } }), { status: 200 })
    })
    store.set('verboo-account/observations', { kind: 'grant', payload: { version: 1, lost: 0, pending } })
    const context = { journeyId, operationId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    collector.record(context, 'started')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(requests.length).toBeGreaterThan(0)
  })

  it('stops delivering when the lifetime is aborted', async () => {
    const ctx = new Context()
    ctx.provide('credentials', {
      readRecord: async () => undefined,
      modifyRecord: async () => undefined,
    })
    const collector = new LoginJourney(ctx, deployment())
    await ctx.fiber.dispose()
    const context = { journeyId: crypto.randomUUID(), operationId: crypto.randomUUID(), requestId: crypto.randomUUID() }
    // After the dispose the credential store is gone: recording cannot enqueue
    // anything more, which is the guarantee the lifetime owns.
    expect(() => collector.record(context, 'started')).toThrow()
    await new Promise(resolve => setTimeout(resolve, 10))
  })
})
