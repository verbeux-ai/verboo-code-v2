/** Desktop-only analytics RPC and live compaction collection. */
import { type Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-host-product-telemetry-otel'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { ProductEvent } from './events.ts'
import {
  desktopModelFailureEvent,
  failureFromAttempt,
  type DesktopModelFailureEvent,
} from './model-failure.ts'
import { collectEnvironment, type EnvironmentAttributes } from './environment.ts'
import type { Session } from '@deepseek-ai/dsh-session'

/** Application-owned collection policy; no user settings surface. */
export interface Config {
  /** Live application collection policy; ordinary Web does not mount this service. */
  enabled: Volatile<boolean>
  /** Running Desktop release, absent when unavailable. */
  appVersion?: string
  /** Maximum execution time per static environment query, in milliseconds. */
  environmentQueryTimeoutMillis: number
  /** Maximum captured bytes per environment query output stream. */
  environmentQueryMaxOutputBytes: number
  /** Optional first-party endpoint for content-free model failure events. */
  observabilityEndpoint?: string
  /** Deadline for one best-effort model failure event submission. */
  observabilityTimeoutMillis: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    productAnalytics: ProductAnalytics
  }
}

/** Authenticated event intake; disabled instances do not inspect identity or accept new events. */
export default class ProductAnalytics extends TypertRemoteService {
  static inject = ['deepseekAccount', 'productTelemetry']
  static Config = z.object({
    enabled: z.boolean().default(true).volatile(), appVersion: z.string(),
    environmentQueryTimeoutMillis: z.number().step(1).min(1).max(2_147_483_647).default(5000),
    environmentQueryMaxOutputBytes: z.number().step(1).min(1).max(2_147_483_647).default(16384),
    observabilityEndpoint: z.string(),
    observabilityTimeoutMillis: z.number().step(1).min(1).max(10_000).default(2000),
  })
  private active = true
  private readonly environmentLifetime = new AbortController()
  private environment: Promise<EnvironmentAttributes> | undefined
  private readonly listeners = new Set<() => void>()
  private readonly modelRoutes = new WeakMap<Session, { provider?: string; model?: string }>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'productAnalytics')
    if (config.observabilityEndpoint !== undefined) {
      let endpoint: URL
      try { endpoint = new URL(config.observabilityEndpoint) } catch (cause) {
        throw new Error('product-analytics: observabilityEndpoint must be a valid HTTP(S) URL', { cause })
      }
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error('product-analytics: observabilityEndpoint must use HTTPS or loopback HTTP without credentials, query, or fragment')
      }
    }
    ctx.effect(() => async () => {
      this.active = false
      for (const listener of this.listeners) listener()
      this.environmentLifetime.abort()
      await this.environment
    })
    ctx.on('loader/volatile-update', () => { for (const listener of this.listeners) listener() })
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.on('session/event', (session, event) => {
      if (!this.enabled()) return
      if (event.type === 'request/header') {
        this.modelRoutes.set(session, {
          provider: event.data.header.config.provider,
          model: event.data.header.config.model,
        })
        return
      }
      if (event.type === 'request/context') {
        this.modelRoutes.set(session, { provider: event.data.provider, model: event.data.model })
        return
      }
      if (event.type === 'assistant/attempt') {
        const failure = failureFromAttempt(event.data.stream)
        if (failure !== undefined) {
          const route = this.modelRoutes.get(session)
          void this.reportModelFailure(desktopModelFailureEvent(failure, {
            timestamp: event.time,
            ...route,
            ...this.config.appVersion === undefined ? {} : { appVersion: this.config.appVersion },
          }))
        }
        return
      }
      if (event.type === 'compaction/start') {
        void this.report({ eventName: 'context_compression', timestamp: Date.now(),
          attributes: { session_id: session.id, trigger_type: event.data.turn === null ? 'manual' : 'auto' } })
      }
    })
  }

  /** Send one safe model-failure event without making collection part of chat success. */
  private async reportModelFailure(event: DesktopModelFailureEvent): Promise<void> {
    const endpoint = this.config.observabilityEndpoint
    if (!this.enabled() || endpoint === undefined) return
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, events: [event] }),
        signal: AbortSignal.timeout(this.config.observabilityTimeoutMillis),
      })
    } catch {
      // Error collection is best-effort and must not interrupt a model turn.
    }
  }

  /**
   * Read the collection policy.
   * @returns whether this Host currently accepts Desktop analytics.
   */
  @Remote
  enabled(): boolean { return this.active && this.config.enabled.get() }

  /**
   * Stream the effective policy initially and after live configuration edits.
   * @param signal - subscriber lifetime.
   * @returns current policy values until cancellation or service disposal.
   */
  @Remote({ mode: 'stream' })
  async *watchPolicy(signal: AbortSignal): AsyncIterable<boolean> {
    let update = Promise.withResolvers<void>()
    const changed = (): void => { update.resolve() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (this.active && !signal.aborted) {
        yield this.enabled()
        await update.promise
        update = Promise.withResolvers<void>()
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
  }

  /**
   * Submit selected Desktop fields with cached static environment and fresh identity.
   * The first intake waits for bounded environment queries; concurrent intakes share them.
   * Missing identity is omitted; failed environment fields carry fixed reasons.
   * @param event - typed product event without message contents or credentials.
   * @returns after local submission; no delivery or warehouse acknowledgement.
   */
  @Remote
  async report(event: ProductEvent): Promise<void> {
    if (!this.enabled()) return
    try {
      this.environment ??= collectEnvironment({
        timeoutMillis: this.config.environmentQueryTimeoutMillis,
        maxOutputBytes: this.config.environmentQueryMaxOutputBytes,
        signal: this.environmentLifetime.signal,
      })
      const [environment, identity] = await Promise.all([
        this.environment, this.ctx.deepseekAccount.getDeviceIdentity().catch(() => undefined),
      ])
      if (!this.enabled()) return
      const { missing_fields: missingFields, ...metadata } = environment
      const missing = Object.entries(missingFields).sort(([a], [b]) => a.localeCompare(b))
        .map(([field, reason]) => `${field}=${reason}`).join(',')
      this.ctx.productTelemetry.emit({
        ...event, body: event.eventName,
        attributes: {
          ...event.attributes,
          ...metadata,
          ...missing === '' ? {} : { missing_fields: missing },
          ...identity?.deviceId === undefined ? {} : { device_id: identity.deviceId },
          ...identity?.userId === undefined ? {} : { user_id: identity.userId },
          ...this.config.appVersion === undefined ? {} : { app_version: this.config.appVersion },
        },
      })
    } catch (error) {
      this.ctx.logger.warn('Product analytics submission failed', error)
    }
  }
}
