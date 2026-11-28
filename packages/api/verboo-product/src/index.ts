/** Host-only Verboo product API. No provider key or account grant crosses Remote. */
import { createHash, randomUUID } from 'node:crypto'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import WebSocket from 'ws'
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
import { parseSpeedFrame } from './live-speed.ts'
import type { AgentBilling } from './agent-billing.ts'
export type { AgentBilling, PreparedAgentPlanChange } from './agent-billing.ts'
import {
  billingData, billingPeriod, billingSubscriptionId, cancellation, changePreview, changeProgress,
  checkoutHandoff, checkoutQuote, invoices, lifecycleAction, offerId, planChangeId, planChangeProgress, purchaseAttempt,
  purchaseDomain, purchaseId, purchaseOptions, purchaseProgress, purchaseRecovery,
} from './billing.ts'
import type {
  BillingInterval, BillingQuoteId, BillingSubscriptionId, PlanChangeId, PlanChangeProgress,
  PlanChangeQuote, PurchaseProgress, PurchaseQuote, PurchaseRecommendation,
  Subscription, SubscriptionCancellation, SubscriptionCardUpdate, SubscriptionInvoice, SubscriptionLifecycleProgress,
} from './types.ts'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import type { TrialStatus, TrialOffer, TrialPayment, TrialId, TrialOfferId, TrialAttemptId } from './types.ts'
import type {
  ConnectionId,
  PlanId,
  Plans,
  UsageWindowsStatus,
  Connections,
  Result,
  StaminaStatus,
  UsagePeriod, UsageSummary, UsageActivityDay, SpeedFrame,
  ProfileSettings, PasswordResult,
} from './types.ts'

/** Public product API deployment addresses; no provider secret is accepted. */
export const Config = Schema.object({
  apiOrigin: Schema.string().default('https://code.verboo.ai'),
  routerBaseURL: Schema.string().default('https://code.verboo.ai/router/v1'),
  allowLoopbackHttp: Schema.boolean().default(false),
  connectionListTimeoutMs: Schema.number().min(1000).max(120_000).default(40_000),
  connectionSearchTimeoutMs: Schema.number().min(1000).max(120_000).default(120_000),
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
  /** Deadline for loading connected accounts and the provider catalog. */
  connectionListTimeoutMs?: number
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
const profileSettings = z.object({ data: z.object({
  id: z.string().min(1), name: z.string(), email: z.string(), hasPassword: z.boolean(),
  publicProfile: z.boolean(), anonymousHandle: z.string().optional(),
}) })
const catalogPrice = z.object({
  priceCents: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  billingInterval: z.enum(['month', 'year']),
})
const plan = z.object({
  id,
  name: z.string(),
  slug: z.string().min(1).optional(),
  description: z.string(),
  priceCents: catalogPrice.shape.priceCents.nullish().catch(null),
  currency: catalogPrice.shape.currency.nullish().catch(null),
  billingInterval: catalogPrice.shape.billingInterval,
  offers: z.array(catalogPrice.extend({
    paymentMethods: z.array(z.string()).optional(),
  }).nullable().catch(null)).max(16).nullish().catch([]),
  billingMode: z.string().optional(),
  newAcquisitionEnabled: z.boolean().default(true),
  apiOnly: z.boolean().default(false),
  usageLimitsEnabled: z.boolean().optional().catch(undefined),
  concurrentRequests: z.number().int().nonnegative().nullish().catch(undefined),
  apiRateLimitRpm: z.number().int().nonnegative().nullish().catch(undefined),
  apiAccessEnabled: z.boolean().optional().catch(undefined),
  structuredOutputEnabled: z.boolean().optional().catch(undefined),
  enableRanking: z.boolean().optional().catch(undefined),
  seatPurchasesEnabled: z.boolean().optional().catch(undefined),
  catalogModels: z.array(z.object({
    modelName: z.string().min(1), displayName: z.string().nullish(), temporary: z.boolean().optional(),
  })).max(500).nullish().catch(undefined),
})
const cardUpdate = z.object({
  id: z.uuid(), status: z.enum(['pending', 'confirmed', 'failed', 'expired']), url: z.string().optional(),
  embedded: z.object({
    clientSecret: z.string().max(2048).regex(/^cs_(test|live)_[A-Za-z0-9]+_secret_(?:[A-Za-z0-9_-]|%[A-Fa-f0-9]{2})+$/),
    publishableKey: z.string().regex(/^pk_(test|live)_[A-Za-z0-9]+$/),
  }).optional(),
})
const subscriptions = z.object({
  data: z
    .array(
      z.object({
        id: z.uuid(),
        groupId: id,
        group: z.object({
          name: z.string(), slug: z.string().min(1).optional(),
          usageLimitsEnabled: plan.shape.usageLimitsEnabled,
          concurrentRequests: plan.shape.concurrentRequests,
          apiRateLimitRpm: plan.shape.apiRateLimitRpm,
        }).nullish(),
        concurrencyRequestsOverride: plan.shape.concurrentRequests,
        concurrencyTier: z.object({ concurrentRequests: plan.shape.concurrentRequests }).nullish().catch(undefined),
        status: z.string(),
        currentPeriodEnd: z.string().nullish(),
        cancelAtPeriodEnd: z.boolean(),
        management: z.object({
          changePlan: z.boolean(), cancelSubscription: z.boolean().optional(),
          reactivateSubscription: z.boolean().optional(), viewInvoices: z.boolean().optional(),
          updatePaymentMethod: z.boolean().optional(), updateCard: z.boolean().optional(),
          removeConcurrencyTier: z.boolean().optional(),
        }),
        activePlanChangeId: planChangeId.nullish(),
        cancellation: cancellation.nullish(),
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
function projectSubscriptions(value: unknown): Subscription[] {
  return subscriptions
    .parse(value)
    .data.map((s) => {
      const base = s.group?.concurrentRequests
      const override = s.concurrencyRequestsOverride ?? 0
      const concurrency = override > 0 ? override : base != null && base > 0
        ? base + (s.concurrencyTier?.concurrentRequests ?? 0) : base
      return {
        id: s.id,
        planId: s.groupId,
        name: s.group?.name ?? s.groupId,
        ...(s.group?.slug === undefined ? {} : { slug: s.group.slug }),
        status: s.status,
        renewsAt: s.currentPeriodEnd ?? null,
        cancelAtEnd: s.cancelAtPeriodEnd,
        canUpgrade: s.management.changePlan,
        ...(s.group?.usageLimitsEnabled === true ? { limitedUsage: {
          ...(concurrency == null ? {} : { concurrentRequests: concurrency }),
          ...(s.group.apiRateLimitRpm == null ? {} : { apiRateLimitRpm: s.group.apiRateLimitRpm }),
        } } : {}),
        ...([s.management.cancelSubscription, s.management.reactivateSubscription,
          s.management.viewInvoices, s.management.updatePaymentMethod, s.management.updateCard].some(flag => flag !== undefined)
          ? { permissions: {
            cancel: s.management.cancelSubscription === true,
            reactivate: s.management.reactivateSubscription === true,
            invoices: s.management.viewInvoices === true,
            paymentMethod: s.management.updatePaymentMethod === true,
            ...(s.management.updateCard === true ? { cardUpdate: true } : {}),
          } } : {}),
        ...(s.activePlanChangeId ? { activeChangeId: s.activePlanChangeId } : {}),
        ...(s.management.removeConcurrencyTier ? { canRemoveTier: true } : {}),
        ...(s.cancellation ? { cancellation: s.cancellation } : {}),
        billing: s.billing
          ? {
            amountMinor: s.billing.amountMinor,
            currency: s.billing.currency,
            interval: s.billing.billingInterval,
          }
          : null,
      }
    })
}
const catalog = z.object({ data: z.array(plan).max(500) })
function projectCatalogPlan(p: z.infer<typeof plan>): Plans['catalog'] {
  const { usageLimitsEnabled, apiAccessEnabled, structuredOutputEnabled, enableRanking, seatPurchasesEnabled } = p
  const common = {
    id: p.id, name: p.name, description: p.description,
    ...(p.slug === undefined ? {} : { slug: p.slug }),
    ...(usageLimitsEnabled === undefined ? {} : { usageLimitsEnabled }),
    ...(p.concurrentRequests == null ? {} : { concurrentRequests: p.concurrentRequests }),
    ...(p.apiRateLimitRpm == null ? {} : { apiRateLimitRpm: p.apiRateLimitRpm }),
    ...(apiAccessEnabled === undefined ? {} : { apiAccessEnabled }),
    ...(structuredOutputEnabled === undefined ? {} : { structuredOutputEnabled }),
    ...(enableRanking === undefined ? {} : { enableRanking }),
    ...(seatPurchasesEnabled === undefined ? {} : { seatPurchasesEnabled }),
    ...(p.catalogModels == null ? {} : {
      models: p.catalogModels.map(m => ({ name: m.displayName || m.modelName, temporary: m.temporary ?? false })),
    }),
  }
  if (p.offers == null) {
    const price = p.priceCents ?? null
    const currency = p.currency ?? null
    return [{ ...common, priceCents: price, currency, interval: p.billingInterval,
      ...(price === null || currency === null ? { unavailable: true } : {}) }]
  }
  const offers = new Map<string, NonNullable<NonNullable<typeof p.offers>[number]>>()
  for (const offer of p.offers) {
    if (offer !== null && offer.paymentMethods?.length !== 0 && !offers.has(offer.billingInterval))
      offers.set(offer.billingInterval, offer)
  }
  return offers.size === 0
    ? [{ ...common, priceCents: null, currency: null, interval: p.billingInterval, unavailable: true }]
    : [...offers.values()].map(offer => ({
      ...common, priceCents: offer.priceCents, currency: offer.currency, interval: offer.billingInterval,
    }))
}
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
const usagePeriod = z.enum(['24h', '7d', '30d', 'current_month', 'previous_month'])
const usageWindowInstant = z.iso.datetime({ offset: true }).nullable()
const usageWindows = z.object({
  data: z.array(z.object({
    groupId: id,
    groupName: z.string(),
    limited: z.boolean(),
    blocked: z.boolean(),
    accountingPending: z.boolean(),
    availableAt: usageWindowInstant,
    windows: z.array(z.object({
      id: z.uuid(),
      durationSeconds: z.number().int().positive(),
      usedPercent: z.number().min(0).max(100),
      resetsAt: usageWindowInstant,
    })).max(100),
  })).max(500),
})
const usageSummary = z.object({ data: z.object({
  timezone: z.string().max(128), bucket: z.enum(['minute', 'hour', 'day']),
  reqTotal: z.number().nonnegative(), tokensInTotal: z.number().nonnegative(),
  tokensOutTotal: z.number().nonnegative(), cachedTokens: z.number().nonnegative(),
  buckets: z.array(z.object({ bucket: z.string().max(128), reqCount: z.number().nonnegative(),
    tokensIn: z.number().nonnegative(), tokensOut: z.number().nonnegative(), cachedTokens: z.number().nonnegative() })).max(1000),
}) })
const usageActivity = z.object({ data: z.array(z.object({ date: z.iso.date(), count: z.number().int().nonnegative() })).max(366) })
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

type BillingOwner = {
  key: string
  session: NonNullable<PlatformSession['sessionId']>
}
type HeldPlanChange = {
  session: BillingOwner['session']
  quote: PlanChangeQuote
  token: string
  operationId: PlanChangeId
  journeyId: string
  concurrencyTierId?: string
}

/** Every request captures its owning login before I/O and fences its response. */
export class VerbooProduct extends TypertRemoteService {
  static inject = ['deepseekAccount']
  private readonly deployment
  private readonly http
  private readonly trialCommerce
  private purchaseStore?: Promise<Domain<typeof purchaseDomain>>
  private readonly purchaseWrites = new Set<string>()
  private readonly subscriptionWrites = new Set<string>()
  private readonly purchaseQuotes = new Map<string, {
    session: PlatformSession['sessionId']
    quote: PurchaseQuote
    token: string
  }>()
  private readonly changeQuotes = new Map<string, HeldPlanChange>()
  private readonly connectionListTimeoutMs: number
  /** Deadline for one provider tool search, which answers past the general ceiling. */
  private readonly connectionSearchTimeoutMs: number
  private readonly connectionExecutionTimeoutMs: number
  constructor(ctx: Context, config: Config) {
    super(ctx, 'verbooProduct', { namespace: 'verboo' })
    this.deployment = deploymentOf(config)
    this.http = new VerbooHttp(this.deployment)
    this.connectionListTimeoutMs = config.connectionListTimeoutMs ?? 40_000
    // The Loader applies Config before construction; the default covers a
    // hand-constructed service.
    /* v8 ignore next -- the schema supplies this field before construction */
    this.connectionSearchTimeoutMs = config.connectionSearchTimeoutMs ?? 120_000
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
  private async request<T = unknown>(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
    correlationId?: string,
    deadlineMs?: number,
    expectedSession?: PlatformSession['sessionId'],
    billingIdentity?: ReturnType<typeof operation>,
    decode?: (value: unknown) => T,
    passwordRequest = false,
  ): Promise<T> {
    const session = await this.ctx.deepseekAccount.getPlatformSession()
    if (session?.sessionId === undefined)
      throw new AccountRequestError('authentication_invalid')
    if (expectedSession !== undefined && session.sessionId !== expectedSession)
      throw new AccountRequestError('request_cancelled')
    const token = await this.ctx.deepseekAccount.resolveToken(
      this.deployment.routerBaseURL,
    )
    if (token === undefined)
      throw new AccountRequestError('authentication_invalid')
    if ((await this.ctx.deepseekAccount.getPlatformSession())?.sessionId !== session.sessionId)
      throw new AccountRequestError('request_cancelled')
    const context = billingIdentity ?? operation()
    const identity = {
      journeyId: correlationId ?? context.journeyId,
      operationId: correlationId ?? context.operationId,
      requestId: context.requestId,
    }
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
          ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
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
      const decoded = decode === undefined ? value as T : decode(value)
      record('succeeded')
      return decoded
    } catch (error) {
      // A response decoder may throw details from the provider payload.
      // Only fixed error categories enter observations or reach callers.
      const safe =
        error instanceof AccountRequestError
          ? error
          : new AccountRequestError('contract_error')
      record('failed', safe)
      if (safe.code === 'authentication_invalid' && !passwordRequest)
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
            error.code === 'checkout_not_started' && error.status !== 503
              ? 'checkout_rejected'
              : error.code === 'quote_rejected'
                ? 'quote_changed'
                : error.code === 'authentication_invalid'
                  ? 'signed_out'
                  : error.code === 'request_cancelled'
                    ? 'account_changed'
                    : error.status === 404
                      ? 'not_found'
                      : error.status === 503
                        ? 'unavailable'
                        : error.status === 428 ? 'terms_required' : 'request_failed',
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
      await this.request('/api/me/connections?catalog=all', 'GET', undefined, signal, undefined, this.connectionListTimeoutMs),
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
        throw connectionExecutionFailure(result.result)
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
    return this.result(() => this.readPlans())
  }

  /** Read the current account's editable settings without exposing credentials. */
  @Remote
  getProfileSettings(): Promise<Result<ProfileSettings>> {
    return this.result(async () => profileSettings.parse(await this.request('/api/me')).data)
  }

  /** Apply one explicit profile change for the active account. */
  @Remote
  updateProfileSettings(input: { owner: string; name?: string; publicProfile?: boolean }): Promise<Result<ProfileSettings>> {
    return this.result(async () => {
      const validated = z.object({
        owner: z.string().min(1), name: z.string().trim().min(1).max(100).optional(), publicProfile: z.boolean().optional(),
      }).strict().parse(input)
      const session = (await this.ctx.deepseekAccount.getPlatformSession())?.sessionId
      if (session === undefined) throw new AccountRequestError('authentication_invalid')
      const current = profileSettings.parse(await this.request('/api/me', 'GET', undefined, undefined, undefined, undefined, session)).data
      if (current.id !== validated.owner) throw new AccountRequestError('request_cancelled')
      const { owner: _owner, ...fields } = validated
      return profileSettings.parse(await this.request('/api/me', 'PATCH', fields, undefined, undefined, undefined, session)).data
    })
  }

  /** Change or set a password without recording its value or mistaking an incorrect password for an expired grant. */
  @Remote
  async updateAccountPassword(input: { owner: string; currentPassword?: string; newPassword: string }): Promise<PasswordResult> {
    try {
      const validated = z.object({
        owner: z.string().min(1), currentPassword: z.string().min(1).max(128).optional(), newPassword: z.string().min(8).max(128),
      }).strict().parse(input)
      const session = (await this.ctx.deepseekAccount.getPlatformSession())?.sessionId
      if (session === undefined) throw new AccountRequestError('authentication_invalid')
      const current = profileSettings.parse(await this.request('/api/me', 'GET', undefined, undefined, undefined, undefined, session)).data
      if (current.id !== validated.owner || current.hasPassword !== (validated.currentPassword !== undefined))
        throw new AccountRequestError('request_cancelled')
      const path = validated.currentPassword === undefined ? '/api/me/set-password' : '/api/me/change-password'
      const { owner: _owner, ...fields } = validated
      await this.request(path, 'POST', fields, undefined, undefined, undefined, session, undefined, undefined, true)
      return { ok: true }
    } catch (error) {
      return { ok: false, code: error instanceof AccountRequestError && error.status === 401 ? 'incorrect_password' : 'failed' }
    }
  }

  /** Revoke every server session for the currently displayed account. */
  @Remote
  signOutAll(owner: string): Promise<Result<null>> {
    return this.result(async () => {
      const session = (await this.ctx.deepseekAccount.getPlatformSession())?.sessionId
      if (session === undefined) throw new AccountRequestError('authentication_invalid')
      const current = profileSettings.parse(await this.request('/api/me', 'GET', undefined, undefined, undefined, undefined, session)).data
      if (current.id !== owner) throw new AccountRequestError('request_cancelled')
      await this.request('/api/me/logout-all', 'POST', undefined, undefined, undefined, undefined, session)
      return null
    })
  }

  private async readPlans(signal?: AbortSignal, expectedSession?: BillingOwner['session']): Promise<Plans> {
    const session = expectedSession ?? (await this.ctx.deepseekAccount.getPlatformSession())?.sessionId
    if (session === undefined) throw new AccountRequestError('authentication_invalid')
    const [owned, available] = await Promise.all([
      this.request('/api/me/subscriptions', 'GET', undefined, signal, undefined, undefined, session),
      this.request('/api/marketplace?includeMetrics=false', 'GET', undefined, signal, undefined, undefined, session),
    ])
    return {
      subscriptions: projectSubscriptions(owned),
      catalog: catalog
        .parse(available)
        .data.filter(
          p =>
            p.newAcquisitionEnabled &&
            !p.apiOnly &&
            p.billingMode !== 'token' &&
            p.billingMode !== 'prepaid_tokens' &&
            p.billingMode !== 'pay_as_you_go',
        )
        .flatMap(projectCatalogPlan),
    }
  }
  /**
   * Read owned subscriptions independently of the commercial catalog.
   * @param signal - cancellation of the owning Client read.
   * @returns display-safe subscriptions for the current account.
   */
  @Remote
  getUsageSubscriptions(signal: AbortSignal): Promise<Result<Subscription[]>> {
    return this.result(async () => projectSubscriptions(await this.request('/api/me/subscriptions', 'GET', undefined, signal)))
  }
  /**
   * Read historical subscription usage without exposing account credentials.
   * @param period - selected reporting period.
   * @param groupId - plan group to read, or null for the account total.
   * @param signal - cancellation of the owning Client read.
   * @returns validated request and token totals for the chosen scope.
   */
  @Remote
  getUsageSummary(period: UsagePeriod, groupId: PlanId | null, signal: AbortSignal): Promise<Result<UsageSummary>> {
    return this.result(async () => {
      const selected = usagePeriod.parse(period)
      const query = new URLSearchParams({ period: selected, billingMode: 'subscription' })
      const path = groupId === null ? '/api/me/usage/summary' : `/api/me/groups/${id.parse(groupId)}/usage/summary`
      return usageSummary.parse(await this.request(`${path}?${query}`, 'GET', undefined, signal)).data
    })
  }

  /**
   * Read the subscription activity calendar independently of historical totals.
   * @param signal - cancellation of the owning Client read.
   * @returns validated daily activity counts for the past year.
   */
  @Remote
  getUsageActivity(signal: AbortSignal): Promise<Result<UsageActivityDay[]>> {
    return this.result(async () => usageActivity.parse(await this.request('/api/me/usage/activity?days=365&billingMode=subscription', 'GET', undefined, signal)).data)
  }

  /**
   * Stream account generation speed from the same service as the web dashboard.
   * @param signal - lifetime of the authenticated speed stream.
   * @returns server measurements without private credentials or concurrency data.
   */
  @Remote({ mode: 'stream' })
  async *watchUsageSpeed(signal: AbortSignal): AsyncIterable<SpeedFrame> {
    const stopped = () => signal.aborted
    const session = await this.ctx.deepseekAccount.getPlatformSession()
    if (!session?.sessionId || stopped()) return
    const result = z.object({ data: z.object({ ticket: z.string().min(1).max(4096) }) })
      .parse(await this.request('/api/me/usage/live-ticket', 'POST', undefined, signal))
    if (stopped() || (await this.ctx.deepseekAccount.getPlatformSession())?.sessionId !== session.sessionId) return
    const frontendOrigin = new URL(this.deployment.apiOrigin).origin
    const endpoint = new URL('/ws/me/usage', frontendOrigin)
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(endpoint.toString(), { origin: frontendOrigin, handshakeTimeout: 6000 })
    let closed = false
    let pending: SpeedFrame | null = null
    let lastAt = 0
    let wake: (() => void) | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const takePending = (): SpeedFrame | null => pending
    const isClosed = () => closed
    const notify = () => { wake?.(); wake = undefined }
    const stop = () => { closed = true; socket.close(); notify() }
    const watch = () => { clearTimeout(timeout); timeout = setTimeout(stop, 6000) }
    signal.addEventListener('abort', stop, { once: true })
    socket.addEventListener('open', () => {
      if (closed || signal.aborted) return
      socket.send(JSON.stringify({ type: 'subscribe', ticket: result.data.ticket, billingMode: 'subscription' }))
      watch()
    })
    socket.addEventListener('message', (event) => {
      if (closed || typeof event.data !== 'string' || event.data.length > 262_144) return
      try {
        const frame = parseSpeedFrame(JSON.parse(event.data))
        const at = frame && Date.parse(frame.at)
        if (!frame || !at || at <= lastAt) return
        lastAt = at
        pending = frame
        watch()
        notify()
      } catch { /* Discard invalid frames without extending their freshness. */ }
    })
    socket.addEventListener('error', stop)
    socket.addEventListener('close', () => { closed = true; notify() })
    watch()
    try {
      while (!stopped() && !isClosed()) {
        const next = takePending()
        if (next === null) { await new Promise<void>((resolve) => { wake = resolve }); continue }
        pending = null
        if ((await this.ctx.deepseekAccount.getPlatformSession())?.sessionId !== session.sessionId || stopped()) return
        yield next
      }
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', stop)
      socket.close()
    }
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
   * Read only the current account's allowance windows for the Plans page.
   * @param signal - cancellation of the owning Client read.
   * @returns the public allowance, usage percentage, and renewal time.
   */
  @Remote
  getUsageWindows(signal: AbortSignal): Promise<Result<UsageWindowsStatus[]>> {
    return this.result(async () =>
      usageWindows.parse(await this.request('/api/me/usage-windows', 'GET', undefined, signal)).data)
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
      const selected = plans.data.catalog.find(plan => plan.id === id.parse(planId) && plan.interval === 'month')
      if (!selected || selected.unavailable || selected.currency?.toUpperCase() !== 'USD') throw new AccountRequestError('contract_error')
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
  private async billingOwner(): Promise<BillingOwner> {
    const session = await this.ctx.deepseekAccount.getPlatformSession()
    if (session === null || session.sessionId === undefined || session.userId === null)
      throw new AccountRequestError('authentication_invalid')
    const key = createHash('sha256').update(this.deployment.apiOrigin + '\0' + session.userId).digest('hex')
    return { key, session: session.sessionId }
  }

  /**
   * Open the canonical billing operations for the current host login.
   * The capability is Host-only and all of its I/O uses the same login.
   * @returns operations bound to the current authenticated account, or a safe refusal.
   */
  agentBilling(): Promise<Result<AgentBilling>> {
    return this.result<AgentBilling>(async () => {
      const owner = await this.billingOwner()
      const isCurrent = async (): Promise<boolean> => {
        const current = await this.billingOwner().catch(() => null)
        return current?.session === owner.session && current.key === owner.key
      }
      const run = <T>(work: () => Promise<T>) => this.result(async () => {
        if (!await isCurrent()) throw new AccountRequestError('request_cancelled')
        const value = await work()
        if (!await isCurrent()) throw new AccountRequestError('request_cancelled')
        return value
      })
      return {
        isCurrent,
        watchOwner: async (signal) => {
          for await (const _state of this.ctx.deepseekAccount.watch(signal, true)) {
            if (signal.aborted) return false
            if (!await isCurrent()) return true
          }
          return false
        },
        plans: signal => run(() => this.readPlans(signal, owner.session)),
        quoteChange: (subscription, plan, interval, signal) => run(async () => {
          const prepared = await this.preparePlanChange(owner, subscription, plan, interval, false, signal)
          let available = true
          return {
            quote: prepared.quote,
            confirm: signal => run(async () => {
              if (!available) throw new AccountRequestError('quote_rejected')
              available = false
              const progress = await this.applyPlanChange(owner, prepared, signal)
              return { progress, submitted: progress.id === prepared.operationId }
            }),
          }
        }),
        cancel: (reviewed, locale, signal) => run(() =>
          this.applySubscriptionLifecycle(owner, billingSubscriptionId.parse(reviewed.id), 'cancel', locale, signal, reviewed)),
        changeStatus: (subscription, change, signal) => run(async () => {
          const key = owner.key + '-' + billingSubscriptionId.parse(subscription.id)
          const saved = (await this.billingStore()).table('changes').get(key)
          const active = subscription.activeChangeId
          const selected = change ?? active ?? saved?.id
          if (selected === undefined) return null
          if (selected === saved?.id) {
            const result = await this.readSavedPlanChange(key, owner.session, signal)
            if (result?.id === selected) return result
          }
          if (selected === active) return this.readPlanChange(owner, selected, signal)
          throw new AccountRequestError('authorization_denied', 404)
        }),
        cancellationStatus: (subscription, signal) => run(() =>
          this.readSubscriptionLifecycle(owner, billingSubscriptionId.parse(subscription), true, signal)),
      }
    })
  }

  private async billingStore() {
    const storage = this.ctx.get('storageDomain')
    if (storage === undefined) throw new AccountRequestError('contract_error')
    if (this.purchaseStore === undefined) {
      const opened = storage.open(purchaseDomain)
      this.purchaseStore = opened
      this.ctx.effect(() => async () => { await (await opened).close() }, 'Verboo: durable purchases')
    }
    return this.purchaseStore
  }

  private async purchases() {
    return (await this.billingStore()).table('purchases')
  }

  /** Verify the next action for a plan under the current login.
   * @param plan - selected catalog plan.
   * @param interval - selected billing period.
   * @returns server-authorized actions for the account.
   */
  @Remote
  billingOptions(plan: PlanId, interval: BillingInterval): Promise<Result<PurchaseRecommendation>> {
    return this.result(async () => {
      const group = id.parse(plan)
      const period = billingPeriod.parse(interval)
      const data = billingData(purchaseOptions, await this.request(
        '/api/me/groups/' + group + '/purchase-options?billingInterval=' + period,
      ))
      if (data.groupId !== group || data.billingInterval !== period)
        throw new AccountRequestError('contract_error')
      return {
        action: data.recommendation === 'checkout' && !data.additionalAllowed ? 'support' : data.recommendation,
        subscriptions: data.subscriptions.map(({ attemptId, ...option }) => ({
          ...option, ...(attemptId === undefined ? {} : { attemptId }),
        })),
      }
    })
  }

  /** Prepare a card quote without starting a purchase.
   * @param plan - selected catalog plan.
   * @param interval - selected billing period.
   * @returns the amounts and currency to review.
   */
  @Remote
  quotePurchase(plan: PlanId, interval: BillingInterval): Promise<Result<PurchaseQuote>> {
    return this.result(async () => {
      const owner = await this.billingOwner()
      const groupId = id.parse(plan)
      const billingInterval = billingPeriod.parse(interval)
      const data = billingData(checkoutQuote, await this.request(
        '/api/me/checkout/quotes', 'POST', {
          purchaseType: 'individual', offer: 'subscription', groupId, billingInterval, quantity: 1, paymentMethod: 'card',
        }, undefined, undefined, undefined, owner.session,
      ))
      if (!data.available || !data.paymentMethods.includes('card')) throw new AccountRequestError('quote_rejected')
      if (data.groupId !== groupId || data.billingInterval !== billingInterval)
        throw new AccountRequestError('contract_error')
      const quote: PurchaseQuote = {
        id: offerId.parse(randomUUID()), planId: groupId, interval: billingInterval,
        initialAmountMinor: data.initialAmountMinor, renewalAmountMinor: data.renewalAmountMinor,
        currency: data.currency, expiresAt: data.expiresAt,
      }
      this.purchaseQuotes.clear()
      this.purchaseQuotes.set(owner.key, { session: owner.session, quote, token: data.quoteId })
      return quote
    })
  }

  /** Confirm one reviewed card quote and retain its identity before sending it.
   * @param quoteId - identifier of the reviewed Host offer.
   * @returns the attempt and any provider handoff.
   */
  @Remote
  confirmPurchase(quoteId: BillingQuoteId): Promise<Result<PurchaseProgress>> {
    return this.result(async () => {
      const owner = await this.billingOwner()
      const held = this.purchaseQuotes.get(owner.key)
      if (held?.session !== owner.session || held.quote.id !== offerId.parse(quoteId) ||
          Date.parse(held.quote.expiresAt) <= Date.now())
        throw new AccountRequestError('quote_rejected')
      if (this.purchaseWrites.has(owner.key)) throw new AccountRequestError('unknown')
      this.purchaseWrites.add(owner.key)
      try {
        const table = await this.purchases()
        if (table.get(owner.key) !== undefined) throw new AccountRequestError('unknown')
        const identity = operation()
        const attemptId = purchaseId.parse(identity.requestId)
        const { planId, interval } = held.quote
        const originalBody = JSON.stringify({
          paymentMethod: 'stripe', billingInterval: interval, purchaseIntent: 'new',
          checkoutQuoteId: held.token, requestId: attemptId, subscribeNow: true, quotedPaymentMethod: 'card',
        })
        const saved = { ...identity, requestId: attemptId, attemptId, planId, interval, originalBody, quoteExpiresAt: held.quote.expiresAt }
        await table.put(owner.key, saved)
        this.purchaseQuotes.delete(owner.key)
        return await this.submitPurchase(owner, saved, originalBody, false)
      } finally {
        this.purchaseWrites.delete(owner.key)
      }
    })
  }

  private async submitPurchase(
    owner: Awaited<ReturnType<VerbooProduct['billingOwner']>>,
    saved: z.infer<typeof purchaseRecovery>,
    body: string,
    retry: boolean,
  ): Promise<PurchaseProgress> {
    const table = await this.purchases()
    const { planId, interval, attemptId, requestId, journeyId, operationId } = saved
    try {
      const data = billingData(checkoutHandoff, await this.request(
        '/api/me/groups/' + planId + '/checkout', 'POST', body,
        undefined, undefined, undefined, owner.session, { requestId, journeyId, operationId },
      ))
      if (data.mode === 'reactivated') {
        await table.delete(owner.key)
        return { id: attemptId, planId, interval, status: 'reactivated', url: null }
      }
      await table.put(owner.key, { requestId, attemptId: data.attemptId, journeyId, operationId, planId, interval })
      const returned = new URL(data.url)
      if (returned.origin === this.deployment.apiOrigin && returned.pathname === '/checkout/return' &&
          returned.searchParams.get('attempt') === data.attemptId) {
        return { id: data.attemptId, planId, interval, status: 'pending', url: null }
      }
      return { id: data.attemptId, planId, interval, status: 'requires_action', url: paymentURL(data.url), canAbandon: true }
    } catch (error) {
      if (!retry && error instanceof AccountRequestError && (
        ['quote_rejected', 'checkout_not_started', 'authentication_invalid'].includes(error.code) || error.status === 428
      )) {
        await table.delete(owner.key)
        throw error
      }
      return { id: attemptId, planId, interval, status: 'unconfirmed', url: null }
    }
  }

  /** Retry the identical authorization only when no server attempt is visible.
   * @param attempt - exact unresolved operation owned by the signed-in account.
   * @returns the reconciliation result or the repeated original request.
   */
  @Remote
  retryPurchase(attempt: PurchaseProgress['id']): Promise<Result<PurchaseProgress>> {
    return this.result(async () => {
      const owner = await this.billingOwner()
      const current = await this.currentPurchase(new AbortController().signal)
      if (!current.ok || current.data?.id !== attempt) throw new AccountRequestError('contract_error')
      if (!current.data.canRetry) return current.data
      if (this.purchaseWrites.has(owner.key)) throw new AccountRequestError('unknown')
      this.purchaseWrites.add(owner.key)
      try {
        const saved = (await this.purchases()).get(owner.key)
        if (saved?.attemptId !== attempt || saved.originalBody === undefined ||
            saved.quoteExpiresAt === undefined || Date.parse(saved.quoteExpiresAt) <= Date.now())
          throw new AccountRequestError('contract_error')
        return await this.submitPurchase(owner, saved, saved.originalBody, true)
      } finally {
        this.purchaseWrites.delete(owner.key)
      }
    })
  }

  /** Reconcile the account's original checkout against the server record.
   * @param signal - lifetime of the visible account read.
   * @returns the original purchase, or null if no local operation exists.
   */
  @Remote
  currentPurchase(signal: AbortSignal): Promise<Result<PurchaseProgress | null>> {
    return this.result(async () => {
      const owner = await this.billingOwner()
      if (this.purchaseWrites.has(owner.key)) return null
      const table = await this.purchases()
      const saved = table.get(owner.key)
      if (saved === undefined) return null
      const { attemptId, requestId, planId, interval, journeyId, operationId } = saved
      if (saved.closedUnstarted) return { id: attemptId, planId, interval, status: 'abandoned', url: null, closedUnstarted: true }
      const readAttempt = async (path: string) => billingData(purchaseAttempt, await this.request(
        path, 'GET', undefined, signal, undefined, undefined, owner.session, { requestId, journeyId, operationId },
      ))
      let data: z.infer<typeof purchaseAttempt>
      try {
        data = await readAttempt('/api/me/purchase-attempts/' + attemptId)
        if (data.id !== attemptId) throw new AccountRequestError('contract_error')
      } catch (error) {
        if (!(error instanceof AccountRequestError) || error.status !== 404) throw error
        if (attemptId !== requestId) return { id: attemptId, planId, interval, status: 'unconfirmed', url: null }
        try {
          data = await readAttempt('/api/me/purchase-attempts/by-request/' + requestId)
        } catch (lookupError) {
          if (!(lookupError instanceof AccountRequestError) || lookupError.status !== 404) throw lookupError
          const expires = saved.originalBody !== undefined && saved.quoteExpiresAt !== undefined
            ? Date.parse(saved.quoteExpiresAt) : undefined
          return {
            id: attemptId, planId, interval, status: 'unconfirmed', url: null,
            canRetry: expires !== undefined && expires > Date.now(),
            ...(expires !== undefined && expires <= Date.now() ? { canAbandon: true } : {}),
          }
        }
      }
      if (data.groupId !== planId || data.billingInterval !== interval ||
          table.get(owner.key)?.requestId !== requestId || this.purchaseWrites.has(owner.key))
        throw new AccountRequestError('contract_error')
      const progress = purchaseProgress(data)
      if (data.id === requestId && data.checkoutReferenceKnown === false && progress.status === 'pending') {
        const canRetry = saved.originalBody !== undefined && saved.quoteExpiresAt !== undefined &&
          Date.parse(saved.quoteExpiresAt) > Date.now()
        return { ...progress, ...(canRetry ? { canRetry: true } : {}) }
      }
      if (data.id !== attemptId || saved.originalBody !== undefined)
        await table.put(owner.key, { requestId, attemptId: data.id, planId, interval, journeyId, operationId })
      return progress
    })
  }

  /** Open the provider's existing session for an eligible original checkout.
   * @param attempt - exact attempt owned by the current account.
   * @returns a validated provider URL.
   */
  @Remote
  resumePurchase(attempt: PurchaseProgress['id']): Promise<Result<string>> {
    return this.result(async () => {
      const attemptId = purchaseId.parse(attempt)
      const owner = await this.billingOwner()
      const table = await this.purchases()
      const saved = table.get(owner.key)
      const identity = saved?.attemptId === attemptId ? saved : { ...operation(), requestId: attemptId }
      const data = billingData(checkoutHandoff, await this.request(
        '/api/me/purchase-attempts/' + attemptId + '/resume', 'GET',
        undefined, undefined, undefined, undefined, owner.session, identity,
      ))
      if (data.mode !== 'stripe' || data.attemptId !== attemptId)
        throw new AccountRequestError('contract_error')
      const url = paymentURL(data.url)
      if (table.get(owner.key) === undefined && !this.purchaseWrites.has(owner.key)) {
        const attemptData = billingData(purchaseAttempt, await this.request(
          '/api/me/purchase-attempts/' + attemptId, 'GET', undefined, undefined, undefined, undefined, owner.session, identity,
        ))
        if (attemptData.id !== attemptId) throw new AccountRequestError('contract_error')
        if (table.get(owner.key) === undefined && !this.purchaseWrites.has(owner.key))
          await table.put(owner.key, {
            ...identity, attemptId, planId: attemptData.groupId, interval: attemptData.billingInterval,
          })
      }
      return url
    })
  }

  /** Close the saved provider attempt after the user explicitly requests it.
   * @param attempt - exact open card checkout to abandon.
   * @returns persisted status after the provider closes the attempt.
   */
  @Remote
  abandonPurchase(attempt: PurchaseProgress['id']): Promise<Result<PurchaseProgress>> {
    return this.result(async () => {
      const owner = await this.billingOwner()
      const attemptId = purchaseId.parse(attempt)
      const current = await this.currentPurchase(new AbortController().signal)
      const table = await this.purchases()
      const saved = table.get(owner.key)
      if (!current.ok || current.data?.id !== attemptId || !current.data.canAbandon ||
          saved?.attemptId !== attemptId || this.purchaseWrites.has(owner.key))
        throw new AccountRequestError('contract_error')
      this.purchaseWrites.add(owner.key)
      try {
        if (current.data.status === 'unconfirmed') {
          const receipt = billingData(z.object({ requestId: purchaseId, closed: z.literal(true) }), await this.request(
            '/api/me/purchase-attempts/by-request/' + saved.requestId + '/close-unstarted',
            'POST', {}, undefined, undefined, undefined, owner.session, saved,
          ))
          if (receipt.requestId !== saved.requestId) throw new AccountRequestError('contract_error')
          const { requestId, journeyId, operationId, planId, interval } = saved
          await table.put(owner.key, { requestId, journeyId, operationId, attemptId, planId, interval, closedUnstarted: true })
          return { id: attemptId, planId, interval, status: 'abandoned', url: null, closedUnstarted: true }
        }
        const data = billingData(purchaseAttempt, await this.request(
          '/api/me/purchase-attempts/' + attemptId + '/abandon', 'POST', {},
          undefined, undefined, undefined, owner.session, saved,
        ))
        if (data.id !== attemptId || data.groupId !== saved.planId || data.billingInterval !== saved.interval)
          throw new AccountRequestError('contract_error')
        return purchaseProgress(data)
      } finally {
        this.purchaseWrites.delete(owner.key)
      }
    })
  }

  /** Clear a resolved operation after verifying that exact attempt.
   * @param attempt - completed or terminal attempt being dismissed.
   * @returns whether its durable recovery record was removed.
   */
  @Remote
  dismissPurchase(attempt: PurchaseProgress['id']): Promise<Result<boolean>> {
    return this.result(async () => {
      const owner = await this.billingOwner()
      if (this.purchaseWrites.has(owner.key)) return false
      const table = await this.purchases()
      if (table.get(owner.key)?.attemptId !== attempt) return false
      const current = await this.currentPurchase(new AbortController().signal)
      if (!current.ok || current.data?.id !== attempt ||
          !['succeeded', 'failed', 'expired', 'abandoned'].includes(current.data.status) ||
          table.get(owner.key)?.attemptId !== attempt || this.purchaseWrites.has(owner.key)) return false
      if ((await this.billingOwner()).session !== owner.session) return false
      return table.delete(owner.key)
    })
  }

  /** Quote an exact change for one owned subscription.
   * @param subscription - existing subscription.
   * @param plan - target plan.
   * @param interval - target billing period.
   * @param removeTier - explicit acceptance that the existing add-on is removed.
   * @returns amounts, effective date, and the opaque confirmation handle.
   */
  @Remote
  quotePlanChange(
    subscription: BillingSubscriptionId, plan: PlanId, interval: BillingInterval, removeTier: boolean,
  ): Promise<Result<PlanChangeQuote>> {
    return this.result(async () => {
      const owner = await this.billingOwner()
      const held = await this.preparePlanChange(owner, subscription, plan, interval, removeTier)
      this.changeQuotes.clear()
      this.changeQuotes.set(owner.key, held)
      return held.quote
    })
  }

  private async preparePlanChange(owner: BillingOwner, subscription: BillingSubscriptionId, plan: PlanId,
    interval: BillingInterval, removeTier: boolean, signal?: AbortSignal): Promise<HeldPlanChange> {
    const subscriptionId = billingSubscriptionId.parse(subscription)
    const targetGroupId = id.parse(plan)
    const targetBillingInterval = billingPeriod.parse(interval)
    const identity = operation()
    const data = billingData(changePreview, await this.request(
      '/api/me/subscriptions/' + subscriptionId + '/change-plan/preview', 'POST',
      { targetGroupId, targetBillingInterval, policyVersion: 2, removeConcurrencyTier: removeTier },
      signal, undefined, undefined, owner.session, identity,
    ))
    if (data.billingInterval !== targetBillingInterval ||
        (data.pixAuthorizationRequired && !data.pixMandateAmountCents))
      throw new AccountRequestError('quote_rejected')
    const quote: PlanChangeQuote = {
      id: offerId.parse(randomUUID()), subscriptionId, targetPlanId: targetGroupId,
      interval: targetBillingInterval, currency: data.currency, amountDueNowCents: data.amountDueNowCents,
      creditNowCents: data.creditNowCents, nextRenewalAmountCents: data.nextRenewalAmountCents,
      nextRenewalAt: data.nextRenewalAt, effectiveAt: data.effectiveAt, expiresAt: data.expiresAt,
      undoesCancellation: data.undoesCancellation, removesConcurrencyTier: data.removesConcurrencyTier,
      ...(data.pixAuthorizationRequired && data.pixMandateAmountCents !== undefined ? {
        pixMandateAmountCents: data.pixMandateAmountCents,
      } : {}),
    }
    return {
      session: owner.session, quote, token: data.previewToken, operationId: data.operationId, journeyId: identity.journeyId,
      ...(data.concurrencyTierId ? { concurrencyTierId: data.concurrencyTierId } : {}),
    }
  }

  /** Confirm only the last reviewed change for the current login.
   * @param quoteId - opaque handle of the reviewed change.
   * @returns the exact operation, even when acceptance is unconfirmed.
   */
  @Remote
  confirmPlanChange(quoteId: BillingQuoteId): Promise<Result<PlanChangeProgress>> {
    return this.result(async () => {
      const owner = await this.billingOwner()
      const held = this.changeQuotes.get(owner.key)
      if (held?.session !== owner.session || held.quote.id !== offerId.parse(quoteId))
        throw new AccountRequestError('quote_rejected')
      this.changeQuotes.delete(owner.key)
      return this.applyPlanChange(owner, held)
    })
  }

  private async applyPlanChange(owner: BillingOwner, held: HeldPlanChange, signal?: AbortSignal): Promise<PlanChangeProgress> {
    if (Date.parse(held.quote.expiresAt) <= Date.now()) throw new AccountRequestError('quote_rejected')
    const { quote, operationId } = held
    const store = await this.billingStore()
    const table = store.table('changes')
    const key = owner.key + '-' + quote.subscriptionId
    if (this.subscriptionWrites.has(key) || store.table('lifecycles').get(key))
      throw new AccountRequestError('unknown')
    this.subscriptionWrites.add(key)
    try {
      const previous = await this.readSavedPlanChange(key, owner.session, signal)
      if (previous && !['completed', 'failed', 'canceled', 'cancelled', 'expired'].includes(previous.status))
        return previous
      if (signal?.aborted) throw new AccountRequestError('request_cancelled')
      if (Date.parse(quote.expiresAt) <= Date.now()) throw new AccountRequestError('quote_rejected')
      const identity = { ...operation(), operationId, journeyId: held.journeyId }
      await table.put(key, { id: operationId, ...identity })
      try {
        const response = await this.request('/api/me/subscriptions/' + quote.subscriptionId + '/change-plan',
          'POST', {
            targetGroupId: quote.targetPlanId, targetBillingInterval: quote.interval,
            previewToken: held.token, removeConcurrencyTier: quote.removesConcurrencyTier,
            ...(held.concurrencyTierId && !quote.removesConcurrencyTier ? { targetConcurrencyTierId: held.concurrencyTierId } : {}),
          }, signal, undefined, undefined, owner.session, identity)
        return planChangeProgress(billingData(changeProgress, response), operationId)
      } catch (error) {
        if (error instanceof AccountRequestError && (error.code === 'quote_rejected' || error.status === 428)) {
          await table.delete(key)
          throw error
        }
        return { id: operationId, status: 'unconfirmed', effectiveAt: null, url: null }
      }
    } finally {
      this.subscriptionWrites.delete(key)
    }
  }

  /** Read the status of the exact change previously requested.
   * @param change - issued plan-change operation.
   * @param signal - lifetime of the visible account read.
   * @returns persisted progress and any safe continuation URL.
   */
  @Remote
  billingChangeStatus(change: PlanChangeId, signal: AbortSignal): Promise<Result<PlanChangeProgress>> {
    return this.result(async () => {
      const operationId = planChangeId.parse(change)
      const owner = await this.billingOwner()
      return this.readPlanChange(owner, operationId, signal)
    })
  }

  private async readPlanChange(owner: BillingOwner, operationId: PlanChangeId, signal: AbortSignal): Promise<PlanChangeProgress> {
    const table = this.ctx.get('storageDomain') === undefined ? undefined : (await this.billingStore()).table('changes')
    const saved = table === undefined ? undefined : [...table.entries()].find(([key, row]) =>
      key.startsWith(owner.key + '-') && row.id === operationId)?.[1]
    const response = await this.request('/api/me/plan-changes/' + operationId, 'GET',
      undefined, signal, undefined, undefined, owner.session, saved)
    return planChangeProgress(billingData(changeProgress, response), operationId)
  }

  /** Restore a change submitted through this Host, including lost responses.
   * @param subscription - exact subscription that was updated.
   * @param signal - lifetime of the visible account read.
   * @returns persisted progress for the exact submitted operation.
   */
  @Remote
  currentBillingChange(subscription: BillingSubscriptionId, signal: AbortSignal): Promise<Result<PlanChangeProgress | null>> {
    return this.result(async () => {
      const owner = await this.billingOwner()
      return this.readSavedPlanChange(owner.key + '-' + billingSubscriptionId.parse(subscription), owner.session, signal)
    })
  }

  private async readSavedPlanChange(key: string, session: PlatformSession['sessionId'], signal?: AbortSignal) {
    const table = (await this.billingStore()).table('changes')
    const saved = table.get(key)
    if (saved === undefined) return null
    try {
      const response = await this.request('/api/me/plan-changes/' + saved.id, 'GET',
        undefined, signal, undefined, undefined, session, saved)
      return planChangeProgress(billingData(changeProgress, response), saved.id)
    } catch (error) {
      if (!(error instanceof AccountRequestError) || error.status !== 404) throw error
      return { id: saved.id, status: 'unconfirmed', effectiveAt: null, url: null }
    }
  }

  private async lifecycleSubscription(
    subscription: BillingSubscriptionId,
    session: PlatformSession['sessionId'],
    signal?: AbortSignal,
    identity?: ReturnType<typeof operation>,
  ) {
    const data = billingData(z.array(z.object({
      id: billingSubscriptionId, status: z.string(), cancelAtPeriodEnd: z.boolean(),
      currentPeriodEnd: z.string().nullish(), activePlanChangeId: planChangeId.nullish(),
      management: z.object({
        cancelSubscription: z.boolean().optional(), reactivateSubscription: z.boolean().optional(),
      }),
      cancellation: cancellation.nullish(),
    })).max(500), await this.request('/api/me/subscriptions', 'GET', undefined, signal,
      undefined, undefined, session, identity))
    return data.find(row => row.id === subscription)
  }

  /** Request one lifecycle action and persist its identity before sending it.
   * @param subscription - exact subscription to mutate.
   * @param action - explicit lifecycle action.
   * @param locale - current presentation locale for cancellation notices.
   * @returns immediate progress, including an unconfirmed response.
   */
  @Remote
  updateSubscription(
    subscription: BillingSubscriptionId,
    action: 'cancel' | 'reactivate',
    locale?: string,
  ): Promise<Result<SubscriptionLifecycleProgress>> {
    return this.result(async () => this.applySubscriptionLifecycle(await this.billingOwner(),
      billingSubscriptionId.parse(subscription), lifecycleAction.parse(action), locale))
  }

  private async applySubscriptionLifecycle(owner: BillingOwner, selected: BillingSubscriptionId,
    method: 'cancel' | 'reactivate', locale?: string, signal?: AbortSignal, reviewed?: Subscription): Promise<SubscriptionLifecycleProgress> {
    const table = (await this.billingStore()).table('lifecycles')
    const key = owner.key + '-' + selected
    if (this.subscriptionWrites.has(key)) throw new AccountRequestError('unknown')
    this.subscriptionWrites.add(key)
    try {
      const existing = table.get(key)
      if (existing) return lifecycleProgress(existing.action, existing.cancellation ?? null)
      const identity = operation()
      const baseline = await this.lifecycleSubscription(selected, owner.session, signal, identity)
      if (baseline === undefined) throw new AccountRequestError('unknown', 404)
      if (method === 'cancel' ? baseline.management.cancelSubscription !== true :
        baseline.management.reactivateSubscription !== true || !baseline.cancelAtPeriodEnd)
        throw new AccountRequestError('authorization_denied', 403)
      if (reviewed && ((baseline.currentPeriodEnd ?? null) !== reviewed.renewsAt ||
          (baseline.activePlanChangeId ?? undefined) !== reviewed.activeChangeId ||
          baseline.cancelAtPeriodEnd !== reviewed.cancelAtEnd || baseline.status !== reviewed.status ||
          baseline.cancellation?.operationId !== reviewed.cancellation?.operationId))
        throw new AccountRequestError('quote_rejected')
      if (signal?.aborted) throw new AccountRequestError('request_cancelled')
      const saved = { ...identity, action: method, baselineCancellationId: baseline.cancellation?.operationId }
      await table.put(key, saved)
      try {
        const language = locale?.toLowerCase().split('-')[0]
        const response = await this.request('/api/me/subscriptions/' + selected + '/' + method, 'POST',
          method === 'cancel' ? { locale: language === 'pt' || language === 'zh' ? language : 'en' } : undefined,
          signal, undefined, undefined, owner.session, identity)
        if (method === 'reactivate') {
          await table.delete(key)
          return { action: method, status: 'confirmed', cancellation: null }
        }
        const progress = lifecycleProgress(method, response === null ? null : billingData(cancellation, response))
        if (progress.status === 'confirmed') await table.delete(key)
        else if (progress.cancellation) await table.put(key, { ...saved, cancellation: progress.cancellation })
        return progress
      } catch (error) {
        if (error instanceof AccountRequestError &&
            (['lifecycle_not_started', 'authentication_invalid'].includes(error.code) || error.status === 428)) {
          await table.delete(key)
          throw error
        }
        return lifecycleProgress(method, null)
      }
    } finally {
      this.subscriptionWrites.delete(key)
    }
  }

  /** Reconcile the saved lifecycle action against the exact subscription.
   * @param subscription - exact subscription selected in Plans.
   * @param signal - lifetime of the visible account read.
   * @param checkCancellation - also refresh a pending cancellation started elsewhere.
   * @returns authoritative progress or null if nothing is being reconciled.
   */
  @Remote
  currentSubscriptionLifecycle(
    subscription: BillingSubscriptionId,
    checkCancellation: boolean,
    signal: AbortSignal,
  ): Promise<Result<SubscriptionLifecycleProgress | null>> {
    return this.result(async () => this.readSubscriptionLifecycle(await this.billingOwner(),
      billingSubscriptionId.parse(subscription), checkCancellation, signal))
  }

  private async readSubscriptionLifecycle(owner: BillingOwner, selected: BillingSubscriptionId,
    checkCancellation: boolean, signal: AbortSignal): Promise<SubscriptionLifecycleProgress | null> {
    const table = (await this.billingStore()).table('lifecycles')
    const key = owner.key + '-' + selected
    if (this.subscriptionWrites.has(key)) return null
    const saved = table.get(key)
    if (saved === undefined && !checkCancellation) return null
    const stillCurrent = () => !signal.aborted && !this.subscriptionWrites.has(key) &&
      table.get(key)?.requestId === saved?.requestId
    if (saved?.action === 'reactivate') {
      const row = await this.lifecycleSubscription(selected, owner.session, signal, saved)
      if (!stillCurrent()) return null
      if (row && !row.cancelAtPeriodEnd && ['active', 'trialing'].includes(row.status)) {
        await table.delete(key)
        return { action: 'reactivate', status: 'confirmed', cancellation: null }
      }
      return lifecycleProgress('reactivate', null)
    }
    let data: SubscriptionCancellation
    try {
      data = billingData(cancellation, await this.request('/api/me/subscriptions/' + selected + '/cancellation',
        'GET', undefined, signal, undefined, undefined, owner.session, saved))
    } catch (error) {
      if (!(error instanceof AccountRequestError) || error.status !== 404) throw error
      return saved && stillCurrent() ? lifecycleProgress('cancel', saved.cancellation ?? null) : null
    }
    if (!stillCurrent()) return null
    const known = saved?.cancellation?.operationId
    if (saved && ((!data.operationId || data.operationId === '00000000-0000-0000-0000-000000000000') ||
        (known ? data.operationId !== known : data.operationId === saved.baselineCancellationId)))
      return lifecycleProgress('cancel', saved.cancellation ?? null)
    const progress = lifecycleProgress('cancel', data)
    if (saved && progress.status === 'confirmed') await table.delete(key)
    else if (saved && known !== data.operationId) await table.put(key, { ...saved, cancellation: data })
    return progress
  }

  /** Read invoices scoped to the selected subscription.
   * @param subscription - exact subscription whose invoices are requested.
   * @returns display fields and an optional safe invoice link.
   */
  @Remote
  billingInvoices(subscription: BillingSubscriptionId): Promise<Result<SubscriptionInvoice[]>> {
    return this.result(async () => billingData(invoices, await this.request(
      '/api/me/subscriptions/' + billingSubscriptionId.parse(subscription) + '/invoices',
    )).map(({ hostedInvoiceUrl, ...invoice }) => ({
      ...invoice, url: hostedInvoiceUrl ? paymentURL(hostedInvoiceUrl) : null,
    })))
  }

  /** Open the current published terms for an account that needs to accept them.
   * @returns the official acceptance page for this deployment.
   */
  @Remote
  async billingTermsURL(): Promise<Result<string>> {
    return this.result(async () => {
      await this.billingOwner()
      return new URL('/pt/terms/accept', this.deployment.apiOrigin).href
    })
  }

  /** Start or resume the secure card setup for one subscription.
   * @param subscription - exact subscription whose renewal card will change.
   * @param requestId - retry identity for this explicit action.
   * @param embedded - use the isolated native card form.
   * @returns the operation and its account-bound Stripe setup.
   */
  @Remote
  startBillingCardUpdate(
    subscription: BillingSubscriptionId, requestId: string, embedded?: boolean,
  ): Promise<Result<SubscriptionCardUpdate>> {
    return this.result(async () => {
      const id = z.uuid().parse(requestId)
      return this.request(
        '/api/me/subscriptions/' + billingSubscriptionId.parse(subscription) + '/card-update',
        'POST', { requestId: id, ...(embedded ? { presentation: 'embedded' } : {}) }, undefined, undefined, undefined, undefined,
        { journeyId: id, operationId: id, requestId: id },
        (response) => {
          const data = billingData(cardUpdate, response)
          const destination = data.url === undefined ? null : new URL(paymentURL(data.url))
          if (destination !== null && (data.status !== 'pending' || destination.host !== 'checkout.stripe.com'))
            throw new AccountRequestError('contract_error')
          if (data.embedded && (!embedded || data.status !== 'pending' || destination !== null ||
            data.embedded.clientSecret.startsWith('cs_test_') !== data.embedded.publishableKey.startsWith('pk_test_')))
            throw new AccountRequestError('contract_error')
          return {
            id: data.id, status: data.status, url: destination?.href ?? null,
            ...(data.embedded === undefined ? {} : {
              embedded: { ...data.embedded, url: new URL('/api/desktop/card-setup', this.deployment.apiOrigin).href },
            }),
          }
        },
      )
    })
  }

  /** Read the latest card setup result proved by the server.
   * @param subscription - exact subscription selected in Plans.
   * @param signal - lifetime of the visible account read.
   * @returns the operation or null when this subscription has no card update.
   */
  @Remote
  currentBillingCardUpdate(subscription: BillingSubscriptionId, signal: AbortSignal): Promise<Result<SubscriptionCardUpdate | null>> {
    return this.result(async () => {
      const data = billingData(cardUpdate.nullable(), await this.request(
        '/api/me/subscriptions/' + billingSubscriptionId.parse(subscription) + '/card-update', 'GET', undefined, signal,
      ))
      return data === null ? null : { id: data.id, status: data.status, url: null }
    })
  }

  /** Request the payment portal for one subscription.
   * @param subscription - exact subscription to manage.
   * @returns a validated provider URL.
   */
  @Remote
  billingPortal(subscription: BillingSubscriptionId): Promise<Result<string>> {
    return this.result(() => this.request(
      '/api/me/subscriptions/' + billingSubscriptionId.parse(subscription) + '/portal',
      'POST', undefined, undefined, undefined, undefined, undefined, undefined,
      (response) => {
        const destination = new URL(paymentURL(billingData(z.object({ url: z.string() }), response).url))
        if (destination.host !== 'billing.stripe.com') throw new AccountRequestError('contract_error')
        return destination.href
      },
    ))
  }

  /**
 * Read only this authenticated user's connections.
 * @returns credential-free states and configured toolkits.
 */
  @Remote
  getConnections(): Promise<Result<Connections>> {
    return this.result(
      async () =>
        connections.parse(await this.request('/api/me/connections?catalog=all', 'GET', undefined, undefined, undefined, this.connectionListTimeoutMs)).data,
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
          ? plans.data.catalog.some(p => p.id === planId && !p.unavailable)
          : plans.data.subscriptions.some(p => p.planId === planId)
        if (!allowed) throw new AccountRequestError('contract_error')
        url.searchParams.set('plan', id.parse(planId))
        if (purchase) url.searchParams.set('action', 'subscribe')
      }
      return url.href
    })
  }
}
function lifecycleProgress(
  action: SubscriptionLifecycleProgress['action'],
  cancellation: SubscriptionCancellation | null,
): SubscriptionLifecycleProgress {
  if (cancellation === null) return { action, status: 'unconfirmed', cancellation }
  const status = cancellation.collectionStatus === 'reconciliation_required' ? 'reconciliation_required' :
    cancellation.collectionStatus === 'stopped' && cancellation.localStatus === 'complete' ? 'confirmed' : 'pending'
  return { action, status, cancellation }
}

/** Fixed commercial stages; no URL, query, card or quote content enters observations. */
function productRequestStage(path: string, method: string): Parameters<typeof observe>[1] | null {
  if (path === '/api/me/subscriptions' || path === '/api/me/trial-status' || path.startsWith('/api/marketplace')) return 'catalog'
  if (path.includes('/trial-conversion')) return 'trial_conversion'
  if (path.includes('/free-tokens/activation') || path.includes('/free-tokens/activate')) return 'trial_activation'
  if (path.includes('/change-plan') || path.includes('/plan-changes/')) return 'plan_change'
  if (method === 'POST' && /^\/api\/me\/subscriptions\/[^/]+\/card-update$/.test(path)) return 'payment_method_change'
  if (method === 'POST' && /^\/api\/me\/subscriptions\/[^/]+\/portal$/.test(path)) return 'payment_portal'
  if (method === 'POST' && /\/subscriptions\/[^/]+\/cancel$/.test(path)) return 'cancellation'
  if (method === 'POST' && path.endsWith('/reactivate')) return 'reactivation'
  if (method === 'GET' && path.endsWith('/cancellation')) return 'catalog'
  if (path.includes('/purchase-attempts/')) return 'payment_return'
  if (method === 'POST' && (path.endsWith('/checkout') || path.endsWith('/checkout/quotes'))) return 'checkout_request'
  return null
}
function connectionIdSchema(value: string): string {
  return connectionId.parse(value)
}
/** Use only fixed backend categories; never expose a provider body to the model. */
function connectionExecutionFailure(result: string): ConnectionExecutionError {
  try {
    const parsed: unknown = JSON.parse(result)
    const value = z.object({ code: z.string() }).safeParse(parsed)
    if (value.success) {
      switch (value.data.code) {
        case 'connection_action_permission_denied': return new ConnectionExecutionError('action_permission_denied')
        case 'connection_action_not_found': return new ConnectionExecutionError('action_not_found')
        case 'connection_action_invalid_arguments': return new ConnectionExecutionError('action_invalid_arguments')
        case 'connection_action_rate_limited': return new ConnectionExecutionError('action_rate_limited')
      }
    }
  } catch { /* Older backends may return non-JSON failure text. */ }
  return new ConnectionExecutionError('action_failed')
}

/** A provider side effect may have committed before its response was lost. */
class ConnectionExecutionError extends Error {
  constructor(
    readonly code: 'action_failed' | 'action_refused' | 'execution_unconfirmed'
      | 'action_permission_denied' | 'action_not_found' | 'action_invalid_arguments' | 'action_rate_limited',
  ) {
    const messages = {
      action_failed: 'Connection action failed: action_failed. Check the service before repeating it.',
      action_refused: 'Connection action failed: action_refused. Check the service before repeating it.',
      execution_unconfirmed: 'Connection action could not be confirmed. Check the service before repeating it.',
      action_permission_denied: 'The provider denied this action. Check the required permissions and supported credential type; this does not prove the connection is disconnected.',
      action_not_found: 'The provider did not find the requested resource or action. Verify its identifier and access.',
      action_invalid_arguments: 'The provider rejected the arguments. Check the tool schema and supplied values.',
      action_rate_limited: 'The provider rate limited this action. Check the service before repeating it.',
    }
    super(messages[code])
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    verbooProduct: VerbooProduct
  }
}
export default VerbooProduct
