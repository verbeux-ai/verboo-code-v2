/** Host-only Verboo product API. No provider key or account grant crosses Remote. */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import Schema from '@deepseek-ai/schemastery'
import {
  AccountRequestError,
  VerbooHttp,
  deploymentOf,
  operation,
  observe,
} from '@deepseek-ai/dsh-verboo-account'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { TrialCommerce, trialStatus, paymentURL } from './trial.ts'
import type { TrialStatus, TrialOffer, TrialPayment, TrialId, TrialOfferId, TrialAttemptId } from './types.ts'
import type {
  ConnectionId,
  PlanId,
  Plans,
  Connections,
  Result,
  StaminaStatus,
} from './types.ts'

/** Public product API deployment addresses; no provider secret is accepted. */
export const Config = Schema.object({
  apiOrigin: Schema.string().default('https://code.verboo.ai'),
  routerBaseURL: Schema.string().default('https://code.verboo.ai/router/v1'),
  allowLoopbackHttp: Schema.boolean().default(false),
  connectionSearchTimeoutMs: Schema.number().min(1000).max(120_000).default(75_000),
  connectionExecutionTimeoutMs: Schema.number().min(1000).max(120_000).default(75_000),
})
/** Public product deployment configuration; provider credentials remain server-side. */
export interface Config {
  /** Origin of the authenticated Verboo product API. */
  apiOrigin?: string
  /** Inference gateway used to resolve the owning account grant. */
  routerBaseURL?: string
  /** Allow cleartext loopback endpoints for local integration fixtures. */
  allowLoopbackHttp?: boolean
  /**
   * Deadline for one provider tool search. Semantic search over a toolkit's
   * catalog answers well past the general per-attempt ceiling, and the caller
   * cannot retry a search that already spent its budget.
   */
  connectionSearchTimeoutMs?: number
  /** Deadline for one provider execution, including the backend's ownership checks. */
  connectionExecutionTimeoutMs?: number
}
const id = z
  .uuid()
  .transform(value => value as PlanId)
const plan = z.object({
  id,
  name: z.string(),
  slug: z.string().min(1).optional(),
  description: z.string(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  billingInterval: z.enum(['month', 'year']),
  billingMode: z.string().optional(),
  newAcquisitionEnabled: z.boolean().default(true),
  apiOnly: z.boolean().default(false),
})
const subscriptions = z.object({
  data: z
    .array(
      z.object({
        id: z.uuid(),
        groupId: id,
        group: z.object({ name: z.string(), slug: z.string().min(1).optional() }).nullish(),
        status: z.string(),
        currentPeriodEnd: z.string().nullish(),
        cancelAtPeriodEnd: z.boolean(),
        management: z.object({ changePlan: z.boolean() }),
        billing: z
          .object({
            amountMinor: z.number().int(),
            currency: z.string(),
            billingInterval: z.enum(['month', 'year']),
          })
          .nullish(),
      }),
    )
    .max(500),
})
const catalog = z.object({ data: z.array(plan).max(500) })
const stamina = z.object({
  data: z.array(z.object({
    groupId: id,
    groupName: z.string(),
    remainingPercent: z.number().min(0).max(100),
    nextOutputTps: z.number().int().min(5).max(100000),
    recovering: z.boolean(),
    fullAt: z.iso.datetime({ offset: true }).nullable(),
    accountingPending: z.boolean(),
    asOf: z.iso.datetime({ offset: true }),
  })).max(500).refine(rows => new Set(rows.map(row => row.groupId)).size === rows.length),
})
const connectionId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,128}$/)
  .transform(value => value as ConnectionId)
const connections = z.object({
  data: z.object({
    available: z.boolean(),
    toolkits: z
      .array(
        z.object({
          slug: z.string(),
          name: z.string(),
          available: z.boolean(),
          authType: z.enum(['oauth', 'credentials', 'none', 'setup']).optional(),
          // A catalog entry without a mark, and a blank or null one, all mean the
          // same thing to the Client, so the parse resolves them to absent. The
          // scheme is restricted because the URL reaches an <img> source.
          logo: z
            .union([z.url({ protocol: /^https?$/ }).max(2048), z.literal('')])
            .nullish()
            .transform(value => (value === null || value === '' ? undefined : value)),
        }),
      )
      .max(10000),
    accounts: z
      .array(
        z.object({
          id: connectionId,
          toolkit: z.string(),
          label: z.string().max(128),
          status: z.enum([
            'connected',
            'pending',
            'expired',
            'failed',
            'disconnected',
            'unknown',
          ]),
        }),
      )
      .max(2000),
  }),
})

/** Every request captures its owning login before I/O and fences its response. */
export class VerbooProduct extends TypertRemoteService {
  static inject = ['deepseekAccount']
  private readonly deployment
  private readonly http
  private readonly trialCommerce
  /** Deadline for one provider tool search, which answers past the general ceiling. */
  private readonly connectionSearchTimeoutMs: number
  private readonly connectionExecutionTimeoutMs: number
  constructor(ctx: Context, config: Config) {
    super(ctx, 'verbooProduct', { namespace: 'verboo' })
    this.deployment = deploymentOf(config)
    this.http = new VerbooHttp(this.deployment)
    // The Loader applies Config before construction; the default covers a
    // hand-constructed service.
    /* v8 ignore next -- the schema supplies this field before construction */
    this.connectionSearchTimeoutMs = config.connectionSearchTimeoutMs ?? 75_000
    this.connectionExecutionTimeoutMs = config.connectionExecutionTimeoutMs ?? 75_000
    this.trialCommerce = new TrialCommerce(
      (path, method, body, correlationId) => this.request(path, method, body, undefined, correlationId),
      async () => {
        const session = await this.ctx.deepseekAccount.getPlatformSession()
        if (session?.sessionId === undefined) throw new AccountRequestError('authentication_invalid')
        return session.sessionId
      },
    )
  }
  private async request(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
    correlationId?: string,
    deadlineMs?: number,
  ): Promise<unknown> {
    const session = await this.ctx.deepseekAccount.getPlatformSession()
    if (session?.sessionId === undefined)
      throw new AccountRequestError('authentication_invalid')
    const token = await this.ctx.deepseekAccount.resolveToken(
      this.deployment.routerBaseURL,
    )
    if (token === undefined)
      throw new AccountRequestError('authentication_invalid')
    if ((await this.ctx.deepseekAccount.getPlatformSession())?.sessionId !== session.sessionId)
      throw new AccountRequestError('request_cancelled')
    const identity = operation()
    if (correlationId) { identity.journeyId = correlationId; identity.operationId = correlationId }
    const stage = productRequestStage(path, method)
    const record = (outcome: 'started' | 'succeeded' | 'failed', error?: AccountRequestError) => {
      if (stage === null) return
      try { observe(identity, stage, outcome, error) }
      catch { /* Operational collection cannot stop a commercial request. */ }
    }
    record('started')
    try {
      const value = await this.http.request(
        this.deployment.apiOrigin + path,
        {
          method,
          ...(signal ? { signal } : {}),
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        identity,
        false,
        deadlineMs,
      )
      if (
        (await this.ctx.deepseekAccount.getPlatformSession())?.sessionId !==
        session.sessionId
      )
        throw new AccountRequestError('request_cancelled')
      record('succeeded')
      return value
    } catch (error) {
      // The HTTP client above converts every transport, status, parse, and
      // timeout failure into an AccountRequestError before it returns here, so
      // a foreign throwable can only come from a broken seam implementation.
      /* v8 ignore next -- the HTTP client converts every failure into AccountRequestError */
      const safe =
        error instanceof AccountRequestError
          ? error
          : new AccountRequestError('contract_error')
      record('failed', safe)
      if (safe.code === 'authentication_invalid')
        await this.ctx.deepseekAccount.rejectToken(token)
      throw safe
    }
  }
  private async result<T>(work: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, data: await work() }
    } catch (error) {
      if (error instanceof AccountRequestError)
        return {
          ok: false,
          code:
            error.code === 'quote_rejected'
              ? 'quote_changed'
              : error.code === 'authentication_invalid'
                ? 'signed_out'
                : error.code === 'request_cancelled'
                  ? 'account_changed'
                  : error.status === 404
                    ? 'not_found'
                    : error.status === 503
                      ? 'unavailable'
                      : 'request_failed',
        }
      return { ok: false, code: 'contract_error' }
    }
  }
  /**
 * Read account-scoped connections for an Agent tool.
 * @param signal - tool cancellation.
 * @returns safe JSON text recorded by the tool pipeline.
 */
  async listAgentConnections(signal: AbortSignal): Promise<string> {
    const data = connections.parse(
      await this.request('/api/me/connections?catalog=all', 'GET', undefined, signal),
    ).data
    return JSON.stringify({ available: data.available, accounts: data.accounts,
      publicServices: data.toolkits.filter(toolkit => toolkit.authType === 'none' && toolkit.available).map(toolkit => ({ id: `public_${toolkit.slug}`, toolkit: toolkit.slug, label: toolkit.name })),
    })
  }
  /**
 * Discover pinned tool definitions for one owned connection.
 * @param connectionId - opaque account identity.
 * @param query - capability description.
 * @param signal - tool cancellation.
 * @returns public tool schema JSON.
 */
  async searchAgentConnections(
    connectionId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = z
      .object({
        data: z
          .array(
            z.object({
              slug: z.string(),
              name: z.string(),
              description: z.string(),
              version: z.string().regex(/^[0-9]{8}_[0-9]{2}$/),
              parameters: z.unknown(),
            }),
          )
          .max(20),
      })
      .parse(
        await this.request(
          '/api/me/connections/tools/search',
          'POST',
          {
            connectionId: connectionIdSchema(connectionId),
            query: z.string().min(1).max(200).parse(query),
          },
          signal,
          undefined,
          this.connectionSearchTimeoutMs,
        ),
      )
    return JSON.stringify(response.data)
  }
  /**
 * Execute exactly one provider action; never retry a write or expose service credentials.
 * @param input - discovered tool, version, owned connection and arguments.
 * @param signal - tool cancellation.
 * @returns the provider's exact JSON text, including wide integers.
 */
  async executeAgentConnection(
    input: {
      connectionId: string
      slug: string
      version: string
      arguments: Record<string, unknown>
    },
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const result = z
        .object({
          data: z.object({ successful: z.boolean(), result: z.string() }),
        })
        .parse(
          await this.request(
            '/api/me/connections/tools/execute',
            'POST',
            input,
            signal,
            undefined,
            this.connectionExecutionTimeoutMs,
          ),
        ).data
      if (!result.successful)
        throw new ConnectionExecutionError('action_failed')
      return result.result
    } catch (error) {
      if (error instanceof ConnectionExecutionError) throw error
      throw new ConnectionExecutionError(
        error instanceof AccountRequestError &&
        [400, 401, 403, 404, 422].includes(error.status ?? 0)
          ? 'action_refused'
          : 'execution_unconfirmed',
      )
    }
  }
  /**
 * Read subscriptions and available recurring plans from the authoritative API.
 * @returns display-safe plan projections.
 */
  @Remote
  getPlans(): Promise<Result<Plans>> {
    return this.result(async () => {
      const [owned, available] = await Promise.all([
        this.request('/api/me/subscriptions'),
        this.request('/api/marketplace?includeMetrics=false'),
      ])
      return {
        subscriptions: subscriptions
          .parse(owned)
          .data.map(s => ({
            id: s.id,
            planId: s.groupId,
            name: s.group?.name ?? s.groupId,
            ...(s.group?.slug === undefined ? {} : { slug: s.group.slug }),
            status: s.status,
            renewsAt: s.currentPeriodEnd ?? null,
            cancelAtEnd: s.cancelAtPeriodEnd,
            canUpgrade: s.management.changePlan,
            billing: s.billing
              ? {
                amountMinor: s.billing.amountMinor,
                currency: s.billing.currency,
                interval: s.billing.billingInterval,
              }
              : null,
          })),
        catalog: catalog
          .parse(available)
          .data.filter(
            p =>
              p.newAcquisitionEnabled &&
              !p.apiOnly &&
              p.billingMode !== 'token' &&
              p.billingMode !== 'pay_as_you_go',
          )
          .map(p => ({
            id: p.id,
            name: p.name,
            ...(p.slug === undefined ? {} : { slug: p.slug }),
            description: p.description,
            priceCents: p.priceCents,
            currency: p.currency,
            interval: p.billingInterval,
          })),
      }
    })
  }
  /**
   * Read stamina only for plans where the server has enrolled this account.
   * @param signal - cancellation of the owning Client read.
   * @returns public percentages and next-request ceilings; older APIs without stamina return an empty list.
   */
  @Remote
  getStamina(signal: AbortSignal): Promise<Result<StaminaStatus[]>> {
    return this.result(async () => {
      try {
        return stamina.parse(await this.request('/api/me/stamina', 'GET', undefined, signal)).data
      } catch (error) {
        if (error instanceof AccountRequestError && error.status === 404) return []
        throw error
      }
    })
  }
  /**
   * Read server-decided trial attention; an unavailable API never means expired.
   * @param signal - cancellation for the owning visible-window read.
   * @returns persisted attention, remaining tokens and paid group access.
   */
  @Remote
  getTrialStatus(signal: AbortSignal): Promise<Result<TrialStatus>> {
    return this.result(async () => trialStatus.parse(await this.request('/api/me/trial-status', 'GET', undefined, signal)).data)
  }
  /**
   * Quote one eligible plan without authorizing payment.
   * @param trialId - the server's current trial notice identifier.
   * @param planId - an eligible USD catalog plan.
   * @param method - requested method; absent selects card.
   * @returns display-only offer data; signed authorizations remain on the Host.
   */
  @Remote
  trialOffer(trialId: TrialId, planId: PlanId, method?: 'card' | 'pix'): Promise<Result<TrialOffer>> {
    return this.result(async () => {
      const plans = await this.getPlans()
      if (!plans.ok) throw new AccountRequestError('contract_error')
      const selected = plans.data.catalog.find(plan => plan.id === id.parse(planId))
      if (!selected || selected.currency.toUpperCase() !== 'USD') throw new AccountRequestError('contract_error')
      return this.trialCommerce.offer(trialId, selected, z.enum(['card', 'pix']).parse(method ?? 'card'))
    })
  }
  /**
   * Authorize only the displayed quote, using an account-bound stable request identity.
   * @param offerId - opaque Host quote identifier.
   * @param method - the payment method displayed in the offer.
   * @param requestId - original purchase identity retained for recovery.
   * @returns confirmation or a pending provider step, never browser-derived success.
   */
  @Remote
  confirmTrialOffer(offerId: TrialOfferId, method: 'card' | 'pix', requestId: TrialAttemptId): Promise<Result<TrialPayment>> {
    return this.result(() => this.trialCommerce.confirm(
      z.uuid().parse(offerId) as TrialOfferId, z.enum(['card', 'pix']).parse(method), requestId,
    ))
  }
  /**
   * Check the original purchase attempt; browser returns never prove completion.
   * @param attemptId - original local purchase attempt identifier.
   * @returns its persisted server status.
   */
  @Remote
  trialPaymentStatus(attemptId: TrialAttemptId): Promise<Result<{ status: string }>> {
    return this.result(async () => z.object({ data: z.object({ status: z.string() }) })
      .parse(await this.request('/api/me/purchase-attempts/' + z.uuid().parse(attemptId))).data)
  }
  /**
   * Reopen only the authenticated user's original provider checkout, without another purchase.
   * @param attemptId - original local purchase attempt identifier.
   * @param trialId - subscription notice for legacy invoice recovery; absent uses checkout recovery only.
   * @returns the existing handoff or persisted completion of that same attempt.
   */
  @Remote
  resumeTrialPayment(attemptId: TrialAttemptId, trialId?: TrialId): Promise<Result<TrialPayment>> {
    return this.result(async () => {
      const attempt = z.uuid().parse(attemptId) as TrialAttemptId
      const original = z.object({ data: z.object({ status: z.string() }) })
        .parse(await this.request('/api/me/purchase-attempts/' + attempt)).data
      if (original.status === 'succeeded') return { status: 'completed', attemptId: attempt, url: null }
      try {
        const response = z.object({ data: z.object({ mode: z.literal('stripe'), attemptId: z.uuid(), url: z.string() }) })
          .parse(await this.request('/api/me/purchase-attempts/' + attempt + '/resume')).data
        if (response.attemptId !== attempt) throw new AccountRequestError('contract_error')
        return { status: 'requires_action', attemptId: attempt, url: paymentURL(response.url) }
      } catch (error) {
        if (!(error instanceof AccountRequestError) || error.status !== 409 || !trialId || trialId.startsWith('tokens:'))
          throw error
        const subscription = z.uuid().parse(trialId)
        const pending = z.object({ data: z.object({
          state: z.string(), attemptId: z.uuid().optional(), hostedInvoiceUrl: z.string().optional(),
        }) })
          .parse(await this.request('/api/me/subscriptions/' + subscription + '/trial-conversion?billingInterval=month')).data
        if (pending.attemptId !== attempt || !['requires_action', 'pix_pending'].includes(pending.state)) throw error
        const url = pending.hostedInvoiceUrl
          ? paymentURL(pending.hostedInvoiceUrl)
          : new URL('/pt/settings/billing?subscription=' + subscription + '&action=convert', this.deployment.apiOrigin).href
        return { status: 'requires_action', attemptId: attempt, url }
      }
    })
  }
  /**
 * Read only this authenticated user's connections.
 * @returns credential-free states and configured toolkits.
 */
  @Remote
  getConnections(): Promise<Result<Connections>> {
    return this.result(
      async () =>
        connections.parse(await this.request('/api/me/connections?catalog=all')).data,
    )
  }
  /**
 * Begin hosted authorization for one enabled toolkit.
 * @param toolkit - provider catalog slug.
 * @param label - user-facing name for this service account.
 * @returns short-lived browser link, never a service key.
 */
  @Remote
  connect(
    toolkit: string,
    label: string,
  ): Promise<
    Result<{ url: string; expiresAt: string; id: ConnectionId | null }>
  > {
    return this.result(async () => {
      const input = z
        .string()
        .regex(/^[a-z0-9_]{1,64}$/)
        .parse(toolkit)
      const response = z
        .object({
          data: z.object({
            url: z.url(),
            expiresAt: z.iso.datetime({ offset: true }),
            id: connectionId.nullable(),
          }),
        })
        .parse(
          await this.request('/api/me/connections/link', 'POST', {
            toolkit: input,
            label: z.string().trim().min(1).max(64).parse(label),
          }),
        ).data
      const link = new URL(response.url)
      if (
        link.protocol !== 'https:' ||
        link.username ||
        link.password ||
        ![
          'connect.composio.dev',
          'backend.composio.dev',
          'composio.dev',
        ].includes(link.hostname)
      )
        throw new AccountRequestError('contract_error')
      return response
    })
  }
  /**
 * Disconnect only an account owned by the authenticated user.
 * @param id - opaque connection ID.
 * @returns after server confirmation.
 */
  @Remote
  disconnect(id: ConnectionId): Promise<Result<null>> {
    return this.result(async () => {
      await this.request(
        '/api/me/connections/' + encodeURIComponent(connectionId.parse(id)),
        'DELETE',
      )
      return null
    })
  }
  /**
 * Construct a trusted official checkout handoff. Payment and upgrades remain owned by the Verboo website.
 * @param planId - catalog or owned plan.
 * @param purchase - open the website's subscribe flow.
 * @returns public URL without credentials.
 */
  @Remote
  billingURL(
    planId: PlanId | null,
    purchase: boolean,
  ): Promise<Result<string>> {
    return this.result(async () => {
      const url = new URL('/pt/plans', this.deployment.apiOrigin)
      if (planId !== null) {
        const plans = await this.getPlans()
        if (!plans.ok) throw new AccountRequestError('contract_error')
        const allowed = purchase
          ? plans.data.catalog.some(p => p.id === planId)
          : plans.data.subscriptions.some(p => p.planId === planId)
        if (!allowed) throw new AccountRequestError('contract_error')
        url.searchParams.set('plan', id.parse(planId))
        if (purchase) url.searchParams.set('action', 'subscribe')
      }
      return url.href
    })
  }
}
/** Fixed commercial stages; no URL, query, card or quote content enters observations. */
function productRequestStage(path: string, method: string): Parameters<typeof observe>[1] | null {
  if (path === '/api/me/subscriptions' || path === '/api/me/trial-status' || path.startsWith('/api/marketplace')) return 'catalog'
  if (path.includes('/trial-conversion')) return 'trial_conversion'
  if (path.includes('/free-tokens/activation') || path.includes('/free-tokens/activate')) return 'trial_activation'
  if (path.includes('/change-plan')) return 'plan_change'
  if (path.includes('/purchase-attempts/')) return 'payment_return'
  if (method === 'POST' && (path.endsWith('/checkout') || path.endsWith('/checkout/quotes'))) return 'checkout_request'
  return null
}
function connectionIdSchema(value: string): string {
  return connectionId.parse(value)
}
/** A provider side effect may have committed before its response was lost. */
class ConnectionExecutionError extends Error {
  constructor(
    readonly code: 'action_failed' | 'action_refused' | 'execution_unconfirmed',
  ) {
    super(
      code === 'execution_unconfirmed'
        ? 'Connection action could not be confirmed. Check the service before repeating it.'
        : `Connection action failed: ${code}. Check the service before repeating it.`,
    )
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    verbooProduct: VerbooProduct
  }
}
export default VerbooProduct
