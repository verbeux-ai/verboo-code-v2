/** Explicit Verboo product measurements; no analytics SDK runs in the editor. */
import { createHash, randomUUID } from 'node:crypto'
import { platform } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { VerbooHttp, deploymentOf, operation, AccountRequestError } from '@deepseek-ai/dsh-verboo-account'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import { productResponseProjection, type ProductResponseState } from './projection.ts'
import { AnalyticsStorageStore, consentSchema, eventSchema, type AnalyticsIdentity } from './storage.ts'
import type { ProductAnalyticsStatus, ProductAnalyticsSubject, ProductConsentResult, ProductFeature, ProductModelDetails, ProductSurface } from './types.ts'
export type * from './types.ts'

/** Public collector configuration; all destination credentials stay on the server. */
export interface Config {
  /** Origin of the Verboo API that owns product consent and event receipts. */
  apiOrigin?: string
  /** Origin of the account router used by the shared deployment configuration. */
  routerBaseURL?: string
  /** Permit an HTTP loopback origin for isolated local tests. */
  allowLoopbackHttp?: boolean
  /** Product surface recorded on admitted events. */
  surface?: ProductSurface
  /** Public build version attached to admitted events. */
  appVersion?: string
  /** Delay in milliseconds between retries of pending deliveries. */
  retryIntervalMs?: number
}

/** Deployment-varying values are explicit in the application composition. */
export const Config = Schema.object({
  apiOrigin: Schema.string().default('https://code.verboo.ai'),
  routerBaseURL: Schema.string().default('https://code.verboo.ai/router/v1'),
  allowLoopbackHttp: Schema.boolean().default(false),
  surface: Schema.union(['desktop', 'cli', 'dashboard']).default('cli'),
  appVersion: Schema.string().default('development'),
  retryIntervalMs: Schema.number().step(1).min(1000).max(300000).default(15000),
})

declare module '@deepseek-ai/cordis' {
  interface Context { verbooAnalytics: VerbooAnalytics }
}

const receiptSchema = z.object({ data: z.object({ status: z.literal('accepted'), receipt: z.object({ eventId: z.uuid(), payloadSha256: z.string().regex(/^[a-f0-9]{64}$/) }) }) })
const consentResponse = z.object({ data: consentSchema.extend({ serverTime: z.iso.datetime({ offset: true }).optional(),
  serverOrder: z.string().regex(/^(0|[1-9][0-9]{0,18})$/).optional(),
  serverProof: z.string().regex(/^v1\.[1-9][0-9]{0,18}\.[a-f0-9]{64}$/).optional() }) })

interface Owner {
  identity: AnalyticsIdentity
  installationSecret: string
  token?: string
  sessionId?: string
  generation: number
}

interface TurnOwner {
  turn: number
  owner: Promise<Owner | undefined>
  reference: OrderReference | undefined
}

interface OrderReference { order: bigint; serverTime: number; proof: string }
interface TurnCheckpoint { turn: number; reference: OrderReference | undefined }

function positiveOrder(value: string | undefined): bigint | undefined {
  if (value === undefined || !/^[1-9][0-9]{0,18}$/.test(value)) return undefined
  const parsed = BigInt(value)
  return parsed <= 9223372036854775807n ? parsed : undefined
}

function allowed(identity: AnalyticsIdentity, at = Date.now()): boolean {
  const consent = identity.consent
  return identity.pendingDecision === null && consent?.enabled === true && consent.decision === 'granted' && Date.parse(consent.expiresAt) > at
}

/**
 * Derive a stable opaque UUID for one response without exporting a session ID.
 * @param sessionId - local session identity.
 * @param turn - committed response turn.
 * @returns a deterministic occurrence identity, preserved across restart.
 */
export function responseOperationId(sessionId: string, turn: number): string {
  const b = createHash('sha256').update(`verboo-product-response:1:${sessionId}:${turn}`).digest().subarray(0, 16)
  b[6] = (b.readUInt8(6) & 15) | 80
  b[8] = (b.readUInt8(8) & 63) | 128
  const s = b.toString('hex')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

/** Host-owned consent, response observation and receipt-checked product outbox. */
export default class VerbooAnalytics extends TypertRemoteService {
  static inject = ['credentials', 'deepseekAccount', 'sessionProjections']
  static Config = Config
  private readonly store: AnalyticsStorageStore
  private readonly deployment
  private readonly http: VerbooHttp
  private readonly config
  private readonly lifetime = new AbortController()
  private readonly tasks = new Set<Promise<void>>()
  private failure: ProductAnalyticsStatus['failure'] = 'none'
  private generation = 0
  private refreshing: Promise<void> | undefined
  private draining: Promise<void> | undefined
  private readonly openedOwners = new Set<string>()
  private readonly turnOwners = new WeakMap<Session, TurnOwner>()
  private readonly turnCheckpoints = new WeakMap<Session, TurnCheckpoint>()
  private readonly loginOwners = new Set<string>()
  private lastReference: OrderReference | undefined
  private loginStart: { attemptId: string; reference: OrderReference | undefined } | undefined

  /** @param ctx - required Host services; no browser state or destination keys. @param config - public deployment configuration. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'verbooAnalytics', { namespace: 'verbooAnalytics' })
    this.config = Config(config)
    this.deployment = deploymentOf(this.config)
    this.http = new VerbooHttp(this.deployment)
    this.store = new AnalyticsStorageStore(ctx.credentials)
    ctx.on('credentials/record-updated', (key) => {
      if (key !== 'verboo-account/default') return
      this.generation++
    })
    ctx.on('verboo-account/login-started', (attemptId) => {
      // Snapshot only a response already received before OAuth starts; a later
      // response must never authorize this attempt retroactively.
      this.loginStart = { attemptId, reference: this.lastReference }
    })
    ctx.on('verboo-account/login-completed', (sessionId, attemptId, startedAt, completedAt) => {
      if (this.loginStart?.attemptId !== attemptId) return
      const start = this.loginStart
      this.loginStart = undefined
      if (start.reference === undefined) return
      if (this.loginOwners.has(sessionId)) return
      this.loginOwners.add(sessionId)
      this.background(this.completedLogin(sessionId, startedAt, completedAt, start.reference)
        .finally(() => { this.loginOwners.delete(sessionId) }))
    })
    ctx.effect(() => async () => {
      this.generation++
      this.lifetime.abort()
      await Promise.all(this.tasks)
    }, 'Verboo optional analytics lifetime')
  }

  async [Service.init](): Promise<void> {
    const projection = await this.ctx.sessionProjections.register(productResponseProjection)
    if (this.lifetime.signal.aborted) return
    this.ctx.on('session/event', (session, event) => {
      const facts = projection.stateOf(session)
      if (event.type === 'turn/start') {
        this.turnCheckpoints.set(session, { turn: event.data.turn, reference: this.lastReference })
        return
      }
      if (event.type === 'user/message' && event.data.source.kind === 'user' && facts.root && facts.turn !== null) {
        if (this.turnOwners.get(session)?.turn !== facts.turn) {
          const checkpoint = this.turnCheckpoints.get(session)
          const owner = this.owner().catch((_error: unknown) => {
            this.failure = 'storage'
            this.ctx.logger.warn('Optional product analytics could not capture response identity', { code: 'identity_unavailable' })
            return undefined
          })
          this.background(owner.then(() => {}))
          this.turnOwners.set(session, { turn: facts.turn, owner,
            reference: checkpoint?.turn === facts.turn ? checkpoint.reference : undefined })
        }
        return
      }
      if (event.type === 'tool/result' && this.config.surface !== 'dashboard' && facts.root && facts.human && facts.stepped && event.data.turn === facts.turn) {
        const capture = this.turnOwners.get(session)
        if (capture?.turn === event.data.turn) {
          this.background(this.completedTool(session, event.seq, event.time, facts.startedAt, event.data.message.isError === true, capture))
        }
        return
      }
      if (event.type !== 'turn/end') return
      const capture = this.turnOwners.get(session)
      this.turnOwners.delete(session)
      this.turnCheckpoints.delete(session)
      if (facts.completedTurn !== event.data.turn || this.config.surface === 'dashboard') return
      if (capture?.turn === event.data.turn) this.background(this.completed(session, facts, event.time, capture))
    })
    this.ctx.effect(() => {
      const timer = setInterval(() => { this.background(this.tick()) }, this.config.retryIntervalMs)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'Verboo optional analytics retry')
    this.background(this.tick())
  }

  private background(work: Promise<void>): void {
    const task = work.catch((error: unknown) => {
      this.failure = error instanceof AccountRequestError ? 'unavailable' : 'storage'
      this.ctx.logger.warn('Optional product analytics unavailable', { code: this.failure })
    }).finally(() => { this.tasks.delete(task) })
    this.tasks.add(task)
  }

  private async owner(): Promise<Owner | undefined> {
    const generation = this.generation
    const session = await this.ctx.deepseekAccount.getPlatformSession()
    if (!this.isGenerationCurrent(generation)) return undefined
    if (session !== null && session.userId === null) return undefined
    const { identity, installationSecret } = await this.store.select(session?.userId ?? undefined)
    if (!this.isGenerationCurrent(generation)) return undefined
    const token = session === null ? undefined : await this.ctx.deepseekAccount.resolveToken(this.deployment.routerBaseURL)
    if (session !== null && token === undefined) return undefined
    if (!this.isGenerationCurrent(generation)) return undefined
    return {
      identity, installationSecret, generation,
      ...(token === undefined ? {} : { token }),
      ...(session?.sessionId === undefined ? {} : { sessionId: session.sessionId }),
    }
  }

  private async current(owner: Owner): Promise<boolean> {
    if (!this.isGenerationCurrent(owner.generation)) return false
    const session = await this.ctx.deepseekAccount.getPlatformSession()
    return this.isGenerationCurrent(owner.generation) && owner.sessionId === session?.sessionId &&
      (session === null ? owner.identity.owner.startsWith('anonymous:') : session.userId === owner.identity.owner)
  }

  private isGenerationCurrent(generation: number): boolean {
    return generation === this.generation && !this.lifetime.signal.aborted
  }

  private headers(owner: Owner): Headers {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-Verboo-Analytics-Scope': owner.identity.secret })
    if (this.config.surface !== 'dashboard') headers.set('X-Verboo-Analytics-Installation', owner.installationSecret)
    if (owner.token !== undefined) headers.set('Authorization', `Bearer ${owner.token}`)
    return headers
  }

  private async request(owner: Owner, path: string, method = 'GET', body?: string): Promise<unknown> {
    if (!(await this.current(owner))) throw new AccountRequestError('request_cancelled')
    const headers = this.headers(owner)
    const value = await this.http.request(this.deployment.apiOrigin + path, {
      method, headers, signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(8000)]),
      ...(body === undefined ? {} : { body }),
    }, operation())
    if (!(await this.current(owner))) throw new AccountRequestError('request_cancelled')
    return value
  }

  private async synchronize(): Promise<void> {
    const owner = await this.owner()
    if (owner === undefined) return
    let response = consentResponse.parse(await this.request(owner, '/api/analytics/product-consent')).data
    const decision = owner.identity.pendingDecision
    if (decision !== null) {
      const revision = owner.identity.pendingRevision ?? 0
      // An offline grant cannot overwrite a newer refusal from another client.
      // A refusal may adopt a fresh revision because it only restricts collection.
      if (decision === 'denied' || response.revision === revision) {
        response = consentResponse.parse(await this.request(owner, '/api/analytics/product-consent', 'PUT', JSON.stringify({ decision, revision: decision === 'denied' ? response.revision : revision, policyVersion: 1 }))).data
      }
    }
    const { serverTime, serverOrder, serverProof, ...consent } = response
    // The server supplies this separately from the persisted consent. Missing
    // or invalid references disable login observation on older backends.
    const order = positiveOrder(serverOrder)
    const reference = serverTime === undefined || order === undefined || serverProof === undefined ||
      serverProof.split('.')[1] !== String(order) ? undefined : { order, serverTime: Date.parse(serverTime), proof: serverProof }
    this.lastReference = reference
    const next = { ...consent, ...(reference === undefined ? {} : { referenceProof: reference.proof }) }
    const discarded = { firstOpen: false }
    await this.store.update((state) => {
      const identity = state.contexts.find(item => item.owner === owner.identity.owner)
      if (identity === undefined || identity.pendingDecision !== decision || owner.generation !== this.generation) return
      identity.consent = next
      identity.pendingDecision = null
      identity.pendingRevision = null
      if (next.decision !== 'granted') state.pending = state.pending.filter((item) => {
        if (item.owner !== identity.owner) return true
        if (item.eventId === state.installationFirstOpenEventId) { state.installationFirstOpenEventId = null; discarded.firstOpen = true }
        if (item.eventId === identity.firstOpenEventId) identity.firstOpenEventId = null
        return false
      })
      else state.pending = state.pending.filter((item) => {
        if (item.owner !== identity.owner) return true
        try {
          const raw: unknown = JSON.parse(item.json)
          if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) &&
            (raw as { schemaVersion?: unknown }).schemaVersion === 1 && !('consentProof' in raw)) {
            // Events from an older collector cannot prove prior consent.
            if (identity.firstOpenEventId === item.eventId) identity.firstOpenEventId = null
            if (state.installationFirstOpenEventId === item.eventId) {
              state.installationFirstOpenEventId = null
              discarded.firstOpen = true
            }
            state.lost++
            return false
          }
          const retained = eventSchema.parse(raw).consentRevision === next.revision
          if (!retained && identity.firstOpenEventId === item.eventId) identity.firstOpenEventId = null
          if (!retained && state.installationFirstOpenEventId === item.eventId) {
            state.installationFirstOpenEventId = null
            discarded.firstOpen = true
          }
          return retained
        }
        catch (_error) { return true } // Invalid pending bytes remain visible and are never sent.
      })
    })
    if (discarded.firstOpen || next.decision !== 'granted' || !next.enabled) this.openedOwners.delete(owner.identity.owner)
    this.failure = 'none'
    if (next.decision !== 'granted' || !next.enabled) return
    // Re-read the stored grant after synchronization, but never adopt a new
    // account or login session that appeared while the request was in flight.
    const captured = await this.owner()
    if (captured === undefined || captured.generation !== owner.generation ||
      captured.identity.owner !== owner.identity.owner || captured.sessionId !== owner.sessionId ||
      captured.identity.consent?.revision !== next.revision || !allowed(captured.identity)) return
    if (!this.openedOwners.has(captured.identity.owner)) {
      this.openedOwners.add(captured.identity.owner)
      this.background(this.opened(captured, reference).then((opened) => {
        if (!opened) this.openedOwners.delete(captured.identity.owner)
      }).catch((error: unknown) => { this.openedOwners.delete(captured.identity.owner); throw error }))
    }
  }

  private async completedLogin(sessionId: string, startedAt: number, completedAt: number, reference: OrderReference): Promise<void> {
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt < 0 ||
      !Number.isFinite(reference.serverTime) || completedAt < startedAt || completedAt > Date.now()) return
    const initial = await this.ctx.deepseekAccount.getPlatformSession()
    if (initial?.sessionId !== sessionId) return
    // The profile supplies the canonical account; this remains background work
    // and never delays or changes the committed OAuth result.
    await this.ctx.deepseekAccount.getProfile({ version: this.config.appVersion, locale: 'en', timezoneOffsetSeconds: 0 })
    const original = await this.owner()
    if (original === undefined || original.sessionId !== sessionId) return
    await this.refresh()
    const current = await this.owner()
    if (current === undefined || current.generation !== original.generation || current.sessionId !== sessionId ||
      current.identity.owner !== original.identity.owner || !allowed(current.identity) ||
      current.identity.consent === null || !this.consentPrecedesReference(current.identity, reference) ||
      Date.parse(current.identity.consent.decidedAt) >= startedAt ||
      Date.parse(current.identity.consent.expiresAt) <= completedAt) return
    await this.enqueue('product_login_completed', {}, completedAt, responseOperationId(`login:${sessionId}`, 0), startedAt, current, reference.proof)
  }

  private async refresh(): Promise<void> {
    this.refreshing ??= this.synchronize().finally(() => { this.refreshing = undefined })
    await this.refreshing
  }

  /**
   * Read the product analytics preference and queue status for the current identity.
   * @returns preference for the current identity; unavailable does not grant collection.
   */
  @Remote
  async status(): Promise<ProductAnalyticsStatus> {
    try { await this.refresh() } catch (error) {
      this.failure = error instanceof AccountRequestError ? 'unavailable' : 'storage'
    }
    try { return await this.localStatus() }
    catch (_error) { return { consent: null, pending: 0, lost: 0, failure: 'storage' } }
  }

  /**
   * Persist an explicit choice. Refusal blocks locally before any network call.
   * @param decision - product-only choice, independent of advertising.
   * @returns confirmed preference, or a fixed failure without credentials.
   */
  @Remote
  async choose(decision: 'granted' | 'denied'): Promise<ProductConsentResult> {
    try {
      const owner = await this.owner()
      if (owner === undefined || !(await this.current(owner))) return { ok: false, code: 'account_changed' }
      // Fence any in-flight grant before persisting a newer explicit choice.
      owner.generation = ++this.generation
      const discarded = { firstOpen: false }
      const previousRefresh = this.refreshing
      await this.store.update((state) => {
        if (owner.generation !== this.generation) return
        const identity = state.contexts.find(item => item.owner === owner.identity.owner)
        if (identity === undefined) throw new Error('product_analytics_identity_unavailable')
        identity.pendingDecision = decision
        identity.pendingRevision = identity.consent?.revision ?? 0
        // New consent cannot resurrect an older pending grant's events.
        state.pending = state.pending.filter((item) => {
          if (item.owner !== identity.owner) return true
          if (item.eventId === state.installationFirstOpenEventId) { state.installationFirstOpenEventId = null; discarded.firstOpen = true }
          if (item.eventId === identity.firstOpenEventId) identity.firstOpenEventId = null
          return false
        })
      })
      if (discarded.firstOpen || decision === 'denied') this.openedOwners.delete(owner.identity.owner)
      if (previousRefresh) await previousRefresh.catch(() => {}) // Its result is fenced; the new choice still needs a fresh read.
      if (!(await this.current(owner))) return { ok: false, code: 'account_changed' }
      await this.refresh()
      const selected = await this.store.read()
      if (selected.contexts.find(item => item.owner === owner.identity.owner)?.pendingDecision !== null) await this.refresh()
      if (!(await this.current(owner))) return { ok: false, code: 'account_changed' }
      const status = await this.localStatus()
      if (status.consent?.decision !== decision) return { ok: false, code: 'unavailable' }
      return { ok: true, status }
    } catch (error) {
      this.failure = error instanceof AccountRequestError ? 'unavailable' : 'storage'
      return { ok: false, code: this.failure }
    }
  }

  private async localStatus(): Promise<ProductAnalyticsStatus> {
    const owner = await this.owner()
    const state = await this.store.read()
    const identity = state.contexts.find(item => item.owner === owner?.identity.owner)
    const consent = identity?.pendingDecision === 'denied' && identity.consent !== null
      ? { ...identity.consent, decision: 'denied' as const }
      : identity?.consent ?? null
    return {
      consent, pending: state.pending.filter(item => item.owner === owner?.identity.owner).length,
      lost: state.lost, failure: this.failure,
    }
  }

  private async enqueue(
    name: string, details: Record<string, string | number>, occurrence = Date.now(), eventId: string = randomUUID(),
    startedAt = occurrence, captured?: Owner, consentProof?: string,
  ): Promise<void> {
    const owner = captured ?? await this.owner()
    if (owner === undefined || !allowed(owner.identity)) return
    const consent = owner.identity.consent
    if (consent === null || startedAt < Date.parse(consent.decidedAt) || consentProof === undefined ||
      !/^v1\.[1-9][0-9]{0,18}\.[a-f0-9]{64}$/.test(consentProof)) return
    const json = JSON.stringify({ schemaVersion: 1, eventId, name, consentRevision: consent.revision, consentProof,
      occurredAt: new Date(occurrence).toISOString(), surface: this.config.surface,
      os: platform() === 'darwin' ? 'macos' : platform() === 'win32' ? 'windows' : platform() === 'linux' ? 'linux' : 'other',
      appVersion: this.config.appVersion, ...details })
    eventSchema.parse(JSON.parse(json))
    if (Buffer.byteLength(json) > 4096) throw new Error('product_analytics_event_capacity')
    await this.store.update((state) => {
      const identity = state.contexts.find(item => item.owner === owner.identity.owner)
      if (identity === undefined || !allowed(identity) || identity.consent?.revision !== consent.revision ||
        owner.generation !== this.generation) return
      // The shared credentials lock makes first-open and login idempotent even
      // when multiple Hosts observe the same installation at the same time.
      if (name === 'product_first_open_observed' && state.installationFirstOpenEventId !== null && state.installationFirstOpenEventId !== undefined) return
      if (name === 'product_login_completed' && identity.observedLogin === owner.sessionId) return
      if (state.pending.some(item => item.eventId === eventId)) return
      if (state.pending.length === 1000) { state.lost++; this.failure = 'storage'; return }
      state.pending.push({ eventId, owner: identity.owner, json, attempts: 0, nextAttemptAt: 0 })
      if (name === 'product_first_open_observed') {
        identity.firstOpenEventId = eventId
        state.installationFirstOpenEventId = eventId
      }
      if (name === 'product_login_completed') identity.observedLogin = owner.sessionId ?? null
    })
  }

  private async currentCaptureOwner(capture: TurnOwner): Promise<Owner | undefined> {
    const original = await capture.owner
    const current = await this.owner()
    if (original === undefined || current === undefined || !allowed(original.identity) ||
      original.identity.owner !== current.identity.owner ||
      original.sessionId !== current.sessionId || original.identity.consent?.revision !== current.identity.consent?.revision ||
      !this.consentPrecedesReference(original.identity, capture.reference)) return undefined
    return current
  }

  private async completed(session: Session, facts: ProductResponseState, at: number, capture: TurnOwner): Promise<void> {
    const current = await this.currentCaptureOwner(capture)
    if (current === undefined) return
    if (facts.completedTurn === null) return
    const id = responseOperationId(session.id, facts.completedTurn)
    await this.enqueue('product_response_completed', {
      operationId: id, modality: facts.modality, outcome: 'completed', durationMs: facts.durationMs,
    }, at, id, facts.startedAt, current, capture.reference?.proof)
  }

  private async completedTool(
    session: Session, seq: number, at: number, startedAt: number, failed: boolean, capture: TurnOwner,
  ): Promise<void> {
    const current = await this.currentCaptureOwner(capture)
    if (current === undefined) return
    const id = responseOperationId(`tool:${session.id}`, seq)
    await this.enqueue('product_feature_used', { feature: 'tool', outcome: failed ? 'failed' : 'completed' },
      at, id, startedAt, current, capture.reference?.proof)
  }

  private consentPrecedesReference(identity: AnalyticsIdentity, reference: OrderReference | undefined): boolean {
    const consent = identity.consent
    if (consent === null || reference === undefined || !Number.isFinite(reference.serverTime)) return false
    const decisionOrder = positiveOrder(consent.decisionOrder)
    return decisionOrder !== undefined && decisionOrder < reference.order && Date.parse(consent.expiresAt) > reference.serverTime
  }

  private async opened(owner: Owner, reference: OrderReference | undefined): Promise<boolean> {
    if (!(await this.current(owner)) || !allowed(owner.identity) || !this.consentPrecedesReference(owner.identity, reference)) return false
    const first = owner.identity.firstOpenEventId === null
    const id = owner.identity.firstOpenEventId ?? randomUUID()
    const now = Date.now()
    if (first) {
      await this.enqueue('product_first_open_observed', {}, now, id, now, owner, reference?.proof)
    }
    await this.enqueue('product_opened', {}, now, randomUUID(), now, owner, reference?.proof)
    return await this.current(owner)
  }

  /**
   * Observe one allowlisted feature without tool names, arguments or page data.
   * @param feature - fixed product category.
   * @param outcome - fixed observation outcome.
   * @param subjectId - consent subject observed when the user initiated the action.
   * @param consentRevision - granted revision observed when the action began.
   * @param consentProof - signed reference observed when the action began.
   * @param model - bounded model and effort dimensions for a message attempt.
   * @returns after the eligible observation's local queue attempt settles.
   */
  @Remote
  feature(feature: ProductFeature, outcome: 'started' | 'completed' | 'failed' | 'cancelled', subjectId: ProductAnalyticsSubject, consentRevision: number, consentProof: string, model?: ProductModelDetails): Promise<void> {
    const at = Date.now()
    const work = (async () => {
      const owner = await this.owner()
      if (owner?.identity.consent?.subjectId !== subjectId || owner.identity.consent.revision !== consentRevision) return
      await this.enqueue('product_feature_used', { feature, outcome,
        ...(model === undefined ? {} : { modelProvider: model.provider, modelName: model.model, modelEffort: model.effort }),
      }, at, randomUUID(), at, owner, consentProof)
    })()
    this.background(work)
    return work
  }

  private async flush(): Promise<void> {
    const owner = await this.owner()
    if (owner === undefined || !allowed(owner.identity)) return
    const state = await this.store.read()
    const batch = state.pending.filter(item => item.owner === owner.identity.owner && item.nextAttemptAt <= Date.now()).slice(0, 12)
    for (const item of batch) {
      if (!(await this.current(owner))) return
      try {
        const queued = eventSchema.parse(JSON.parse(item.json))
        if (queued.eventId !== item.eventId) throw new AccountRequestError('contract_error')
        const response = receiptSchema.parse(await this.request(owner, '/api/analytics/product-events', 'POST', item.json)).data
        const digest = createHash('sha256').update(item.json).digest('hex')
        if (response.receipt.eventId !== item.eventId || response.receipt.payloadSha256 !== digest) throw new AccountRequestError('contract_error')
        await this.store.update((state) => {
          state.pending = state.pending.filter(pending => pending.eventId !== item.eventId || pending.json !== item.json)
        })
      } catch (error) {
        this.failure = error instanceof AccountRequestError && error.status !== undefined && error.status >= 400 && error.status < 500 ? 'rejected' : 'unavailable'
        await this.store.update((state) => {
          const pending = state.pending.find(pending => pending.eventId === item.eventId && pending.json === item.json)
          if (pending !== undefined) {
            pending.attempts++
            pending.nextAttemptAt = Date.now() + Math.min(300000, this.config.retryIntervalMs * 2 ** Math.min(pending.attempts, 5))
          }
        })
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.draining !== undefined) return this.draining
    this.draining = (async () => { await this.refresh(); await this.flush() })().finally(() => { this.draining = undefined })
    return this.draining
  }
}
