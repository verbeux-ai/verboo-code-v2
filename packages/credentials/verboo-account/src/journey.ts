/** Durable anonymous login observations; delivery never changes authentication outcomes. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { Operation } from './http.ts'
import { AccountRequestError, observe, VerbooHttp } from './http.ts'
import type { Deployment } from './config.ts'

const KEY = credentialKey('verboo-account', 'observations')
const item = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  release: z.string(),
  json: z.string().max(2048),
})
const queue = z.object({
  version: z.literal(1),
  lost: z.number().nonnegative().int(),
  pending: z.array(item).max(1000),
})
const receipt = z.object({
  data: z.object({
    receipts: z.array(
      z.object({
        eventId: z.uuid(),
        journeyId: z.uuid(),
        clientApp: z.string(),
        payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
  }),
})

/** Version-preserving login observation queue with idempotent receipt-checked delivery. */
export class LoginJourney {
  private draining: Promise<void> | undefined
  private readonly lifetime = new AbortController()
  private readonly tasks = new Set<Promise<void>>()

  /**
 * @param ctx - durable credential-record storage, never used to obtain a bearer token.
 * @param deployment - validated collector origin.
 */
  constructor(
    private readonly ctx: Context,
    private readonly deployment: Deployment,
  ) {
    ctx.effect(() => {
      this.track(this.drain())
      return async () => {
        this.lifetime.abort()
        await Promise.all(this.tasks)
      }
    }, 'Verboo login observations')
  }

  /**
   * Queue a UI observation as anonymous, retaining its original JSON and release across replays.
   * @param context - identity captured before opening authorization.
   * @param outcome - UI authorization outcome, never payment or access confirmation.
   * @param error - fixed diagnostic code without provider response content.
   */
  record(
    context: Operation,
    outcome: 'started' | 'succeeded' | 'failed',
    error?: AccountRequestError,
  ): void {
    observe(context, 'login', outcome, error)
    const json = JSON.stringify({
      eventId: randomUUID(),
      journeyId: context.journeyId,
      operationId: context.operationId,
      stage: 'login',
      outcome,
      occurredAt: new Date().toISOString(),
      ...(error
        ? {
          errorCode: error.code,
          ...(error.status ? { httpStatus: error.status } : {}),
        }
        : {}),
    })
    this.track(
      this.ctx.credentials
        .modifyRecord(KEY, (current) => {
          const state =
            current?.kind === 'grant'
              ? queue.parse(current.payload)
              : { version: 1 as const, lost: 0, pending: [] }
          if (state.pending.length === 1000) {
            console.error('[verboo-journey] collection_loss', json)
            return Promise.resolve({
              kind: 'grant',
              payload: { ...state, lost: state.lost + 1 },
            })
          }
          return Promise.resolve({
            kind: 'grant',
            payload: {
              ...state,
              pending: [
                ...state.pending,
                { schemaVersion: 1, release: APP_IDENTITY.version, json },
              ],
            },
          })
        })
        .then(() => this.drain()),
    )
  }

  private track(work: Promise<unknown>): void {
    const task = work
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(
          '[verboo-journey] collection_pending',
          error instanceof AccountRequestError
            ? { code: error.code, status: error.status }
            : { code: 'contract_error' },
        )
      })
      .finally(() => this.tasks.delete(task))
    this.tasks.add(task)
  }

  private drain(): Promise<void> {
    return (this.draining ??= this.deliver().finally(() => {
      this.draining = undefined
    }))
  }

  private deliveryStopped(): boolean { return this.lifetime.signal.aborted }

  private async deliver(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      const record = await this.ctx.credentials.readRecord(KEY)
      if (record === undefined) return
      if (record.kind !== 'grant')
        throw new AccountRequestError('contract_error')
      const state = queue.parse(record.payload)
      if (state.pending.length === 0) return
      const first = state.pending[0]
      if (first === undefined) return
      const version = first.schemaVersion
      const batch: typeof state.pending = []
      for (const pending of state.pending) {
        if (pending.schemaVersion !== version || batch.length === 20) break
        batch.push(pending)
      }
      // Writes opt into retries only here: event IDs and exact bytes are idempotent at the receiver.
      const body = `{"schemaVersion":${version},"events":[${batch.map(value => value.json).join(',')}]}`
      let result: unknown
      for (let attempt = 0; ; attempt++) {
        try {
          result = await new VerbooHttp(this.deployment).request(
            `${this.deployment.apiOrigin}/api/journey/events`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
              signal: this.lifetime.signal,
            },
          )
          break
        } catch (error) {
          if (
            this.deliveryStopped() ||
            attempt === 2 ||
            (error instanceof AccountRequestError &&
              error.status !== undefined &&
              error.status < 500 &&
              ![408, 429].includes(error.status))
          )
            throw error
        }
      }
      const received = receipt.parse(result).data.receipts
      for (const value of batch) {
        const event = z.object({ eventId: z.uuid(), journeyId: z.uuid() }).parse(JSON.parse(value.json))
        const digest = createHash('sha256')
          .update(`${value.schemaVersion}:${value.json}`)
          .digest('hex')
        if (
          !received.some(
            item =>
              item.eventId === event.eventId &&
              item.journeyId === event.journeyId &&
              item.clientApp === '' &&
              item.payloadSha256 === digest,
          )
        ) {
          throw new AccountRequestError('contract_error')
        }
      }
      const delivered = new Set(batch.map(value => value.json))
      await this.ctx.credentials.modifyRecord(KEY, (current) => {
        if (current?.kind !== 'grant')
          throw new AccountRequestError('contract_error')
        const latest = queue.parse(current.payload)
        return Promise.resolve({
          kind: 'grant',
          payload: {
            ...latest,
            pending: latest.pending.filter(
              value => !delivered.has(value.json),
            ),
          },
        })
      })
    }
  }
}
