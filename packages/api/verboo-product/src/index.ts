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
})
/** Public product deployment configuration; provider credentials remain server-side. */
export interface Config {
  /** Origin of the authenticated Verboo product API. */
  apiOrigin?: string
  /** Inference gateway used to resolve the owning account grant. */
  routerBaseURL?: string
  /** Allow cleartext loopback endpoints for local integration fixtures. */
  allowLoopbackHttp?: boolean
}
const id = z
  .uuid()
  .transform(value => value as PlanId)
const plan = z.object({
  id,
  name: z.string(),
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
        group: z.object({ name: z.string() }).nullish(),
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
        }),
      )
      .max(100),
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
  constructor(ctx: Context, config: Config) {
    super(ctx, 'verbooProduct', { namespace: 'verboo' })
    this.deployment = deploymentOf(config)
    this.http = new VerbooHttp(this.deployment)
  }
  private async request(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
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
    const catalogRead =
      path === '/api/me/subscriptions' || path.startsWith('/api/marketplace')
    if (catalogRead) observe(identity, 'catalog', 'started')
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
      )
      if (
        (await this.ctx.deepseekAccount.getPlatformSession())?.sessionId !==
        session.sessionId
      )
        throw new AccountRequestError('request_cancelled')
      if (catalogRead) observe(identity, 'catalog', 'succeeded')
      return value
    } catch (error) {
      const safe =
        error instanceof AccountRequestError
          ? error
          : new AccountRequestError('contract_error')
      if (catalogRead) observe(identity, 'catalog', 'failed', safe)
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
            error.code === 'authentication_invalid'
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
    return JSON.stringify(
      connections.parse(
        await this.request('/api/me/connections', 'GET', undefined, signal),
      ).data,
    )
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
 * Read only this authenticated user's connections.
 * @returns credential-free states and configured toolkits.
 */
  @Remote
  getConnections(): Promise<Result<Connections>> {
    return this.result(
      async () =>
        connections.parse(await this.request('/api/me/connections')).data,
    )
  }
  /**
 * Begin hosted OAuth for one enabled toolkit.
 * @param toolkit - server-allowlisted slug.
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
