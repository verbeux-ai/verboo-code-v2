/** Host-owned trial quotes. Provider IDs and signed payment authorizations never cross Remote. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AccountRequestError } from '@deepseek-ai/dsh-verboo-account'
import type { PlanId, TrialOffer, TrialPayment, TrialId, TrialOfferId, TrialAttemptId } from './types.ts'

/** Validates persisted trial attention and group-scoped paid access returned by the backend. */
export const trialStatus = z.object({
  data: z.object({
    asOf: z.iso.datetime({ offset: true }),
    paidGroupIds: z
      .array(z.uuid().transform(s => s as PlanId))
      .max(500)
      .default([]),
    trials: z
      .array(
        z.object({
          id: z.string().min(1).max(100).transform(value => value as TrialId),
          groupId: z.uuid().transform(s => s as PlanId),
          source: z.enum(['free_tokens', 'trial', 'stripe_trial']),
          canConvert: z.boolean().default(false),
          hasSavedCard: z.boolean().default(false),
          pendingAttemptId: z.uuid().transform(value => value as TrialAttemptId).optional(),
          state: z.enum(['ending', 'ended']),
          endsAt: z.iso.datetime({ offset: true }).optional(),
          tokensRemaining: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .optional(),
          tokenLimit: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .optional(),
        }),
      )
      .max(500),
  }),
})
const card = z.object({
  brand: z.string().min(1).max(32),
  last4: z.string().regex(/^\d{4}$/),
})
const conversion = z.object({
  data: z.object({
    contractVersion: z.literal(2),
    state: z.enum([
      'active',
      'confirm_card',
      'choose_payment',
      'pix_pending',
      'requires_action',
    ]),
    amountCents: z.number().int().nonnegative(),
    baseAmountCents: z.number().int().nonnegative().optional(),
    tierAmountCents: z.number().int().nonnegative().optional(),
    currency: z.string().optional(),
    billingInterval: z.enum(['month', 'year']).optional(),
    conversionToken: z.string().max(8192).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    card: card.nullish(),
    hostedInvoiceUrl: z.string().optional(),
    attemptId: z.uuid().transform(value => value as TrialAttemptId).optional(),
    paymentMethods: z.array(z.string()).optional(),
  }),
})
const quote = z.object({
  data: z.object({
    available: z.boolean(),
    quoteId: z.string().max(8192).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    currency: z.string(),
    initialAmountMinor: z.number().int().nonnegative(),
    renewalAmountMinor: z.number().int().nonnegative(),
    pixAvailable: z.boolean().default(false),
    pixMandateAmountMinor: z.number().int().positive().optional(),
    paymentMethods: z.array(z.enum(['card', 'pix'])),
    billingInterval: z.enum(['month', 'year']),
  }),
})
type Request = (
  path: string,
  method?: string,
  body?: unknown,
  correlationId?: string,
) => Promise<unknown>
type HeldOffer = {
  view: TrialOffer
  owner: string
  token: string
  subscription: string | null
  changePreview?: { token: string; operationId: string; subscription: string }
  kind?: 'free_tokens'
  requestId?: TrialAttemptId
  pending?: Promise<TrialPayment>
  payment?: TrialPayment
}

/**
 * Validate provider destinations before opening them without account grants.
 * @param raw - provider-issued URL, never a renderer-provided redirect.
 * @returns the validated HTTPS destination.
 */
export function paymentURL(raw: string): string {
  const url = new URL(raw)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    ![
      'checkout.stripe.com',
      'billing.stripe.com',
      'invoice.stripe.com',
    ].includes(url.hostname)
  )
    throw new AccountRequestError('contract_error')
  return url.href
}

/** One quote cache per Host instance; every mutation rechecks the captured login. */
export class TrialCommerce {
  private readonly offers = new Map<TrialOfferId, HeldOffer>()
  constructor(
    private readonly request: Request,
    private readonly owner: () => Promise<string>,
  ) {}
  /**
   * Read a fresh quote before presenting authorization; this never initiates a charge.
   * @param trialId - current server trial notice identifier.
   * @param plan - catalog plan and billing interval selected by the buyer.
   * @param method - requested payment method; absent selects card.
   * @returns display data or the existing pending attempt, without signed tokens.
   */
  async offer(
    trialId: TrialId,
    plan: { id: PlanId; name: string; interval: string },
    method: 'card' | 'pix' = 'card',
  ): Promise<TrialOffer> {
    const owner = await this.owner()
    const notices = trialStatus.parse(
      await this.request('/api/me/trial-status'),
    ).data
    const trial = notices.trials.find(t => t.id === trialId)
    if (!trial) throw new AccountRequestError('contract_error')
    if (method === 'pix' && trial.source === 'stripe_trial' && trial.canConvert)
      throw new AccountRequestError('contract_error')
    let held: HeldOffer
    if (trial.pendingAttemptId) {
      const payment: TrialPayment = {
        status: 'pending',
        attemptId: trial.pendingAttemptId,
        url: null,
      }
      const view: TrialOffer = {
        id: randomUUID() as TrialOfferId,
        pending: payment,
        paymentMethod: method,
        pixAvailable: false,
        planId: plan.id,
        name: plan.name,
        amountMinor: 0,
        renewalAmountMinor: 0,
        currency: 'USD',
        interval: 'month',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        card: null,
        methods: [],
      }
      if ((await this.owner()) !== owner)
        throw new AccountRequestError('request_cancelled')
      return view
    }
    if (
      trial.source === 'free_tokens' &&
      trial.hasSavedCard &&
      trial.groupId === plan.id &&
      method === 'card'
    ) {
      const activation = z
        .object({
          data: z.object({
            token: z.string().max(8192),
            attemptId: z.uuid().transform(value => value as TrialAttemptId),
            groupId: z.uuid(),
            amountCents: z.number().int().nonnegative(),
            renewalAmountCents: z.number().int().nonnegative(),
            currency: z.string(),
            billingInterval: z.enum(['month', 'year']),
            expiresAt: z.iso.datetime({ offset: true }),
            card: card.nullish(),
          }),
        })
        .parse(await this.request('/api/me/free-tokens/activation')).data
      if (
        !activation.card ||
        activation.groupId !== plan.id ||
        activation.billingInterval !== plan.interval
      )
        throw new AccountRequestError('contract_error')
      const acquisition = quote.parse(
        await this.request('/api/me/checkout/quotes', 'POST', {
          purchaseType: 'individual',
          offer: 'subscription',
          groupId: plan.id,
          billingInterval: plan.interval,
          quantity: 1,
        }),
      ).data
      held = {
        owner,
        token: activation.token,
        subscription: null,
        kind: 'free_tokens',
        view: {
          id: randomUUID() as TrialOfferId,
          paymentMethod: 'card',
          pixAvailable: acquisition.available && acquisition.pixAvailable,
          planId: plan.id,
          name: plan.name,
          attemptId: activation.attemptId,
          amountMinor: activation.amountCents,
          renewalAmountMinor: activation.renewalAmountCents,
          currency: activation.currency.toUpperCase(),
          interval: activation.billingInterval,
          expiresAt: activation.expiresAt,
          card: activation.card,
          methods: ['card'],
        },
      }
    } else if (
      trial.source === 'stripe_trial' &&
      trial.canConvert &&
      trial.groupId === plan.id &&
      method === 'card'
    ) {
      let result: z.infer<typeof conversion>['data']
      try {
        result = conversion.parse(
          await this.request(
            `/api/me/subscriptions/${z.uuid().parse(trial.id)}/trial-conversion?billingInterval=${plan.interval}`,
          ),
        ).data
      } catch (error) {
        if (error instanceof AccountRequestError && error.status === 409) {
          const current = trialStatus
            .parse(await this.request('/api/me/trial-status'))
            .data.trials.find(item => item.id === trialId)
          // The provider read above may have authoritatively closed a stale local trial.
          if (current && !current.canConvert && (await this.owner()) === owner)
            return this.offer(trialId, plan, method)
        }
        throw error
      }
      if (
        ['pix_pending', 'requires_action'].includes(result.state) &&
        result.attemptId
      ) {
        const pending: TrialPayment = {
          status:
            result.state === 'requires_action' ? 'requires_action' : 'pending',
          attemptId: result.attemptId,
          url: result.hostedInvoiceUrl
            ? paymentURL(result.hostedInvoiceUrl)
            : null,
        }
        const view: TrialOffer = {
          id: randomUUID() as TrialOfferId,
          pending,
          paymentMethod: 'card',
          pixAvailable: false,
          planId: plan.id,
          name: plan.name,
          ...(result.attemptId ? { attemptId: result.attemptId } : {}),
          amountMinor: result.amountCents,
          renewalAmountMinor:
            result.baseAmountCents === undefined
              ? result.amountCents
              : result.baseAmountCents + (result.tierAmountCents ?? 0),
          currency: result.currency?.toUpperCase() ?? 'USD',
          interval: result.billingInterval ?? 'month',
          expiresAt:
            result.expiresAt ?? new Date(Date.now() + 300000).toISOString(),
          card: result.card ?? null,
          methods: [],
        }
        if ((await this.owner()) !== owner)
          throw new AccountRequestError('request_cancelled')
        return view
      }
      if (
        !['confirm_card', 'choose_payment'].includes(result.state) ||
        !result.conversionToken ||
        !result.expiresAt ||
        !result.currency ||
        !result.billingInterval ||
        (result.state === 'confirm_card' && !result.card)
      )
        throw new AccountRequestError('contract_error')
      held = {
        owner,
        token: result.conversionToken,
        subscription: trial.id,
        view: {
          id: randomUUID() as TrialOfferId,
          paymentMethod: 'card',
          pixAvailable: false,
          planId: plan.id,
          name: plan.name,
          ...(result.attemptId ? { attemptId: result.attemptId } : {}),
          amountMinor: result.amountCents,
          renewalAmountMinor:
            result.baseAmountCents === undefined
              ? result.amountCents
              : result.baseAmountCents + (result.tierAmountCents ?? 0),
          currency: result.currency.toUpperCase(),
          interval: result.billingInterval,
          expiresAt: result.expiresAt,
          card: result.card ?? null,
          methods: ['card'],
        },
      }
    } else if (
      trial.source === 'stripe_trial' &&
      trial.canConvert &&
      trial.groupId !== plan.id &&
      method === 'card'
    ) {
      const preview = z
        .object({
          data: z.object({
            policyVersion: z.literal(2),
            timing: z.literal('trial'),
            trialTransfer: z.literal(true),
            operationId: z.uuid(),
            previewToken: z.string().max(8192),
            nextRenewalAmountCents: z.number().int().positive(),
            currency: z.string(),
            billingInterval: z.enum(['month', 'year']),
            expiresAt: z.iso.datetime({ offset: true }),
          }),
        })
        .parse(
          await this.request(
            `/api/me/subscriptions/${z.uuid().parse(trial.id)}/change-plan/preview`,
            'POST',
            {
              policyVersion: 2,
              targetGroupId: plan.id,
              targetBillingInterval: plan.interval,
              removeConcurrencyTier: false,
            },
          ),
        ).data
      held = {
        owner,
        token: '',
        subscription: null,
        changePreview: {
          token: preview.previewToken,
          operationId: preview.operationId,
          subscription: trial.id,
        },
        view: {
          id: randomUUID() as TrialOfferId,
          paymentMethod: 'card',
          pixAvailable: false,
          planId: plan.id,
          name: plan.name,
          amountMinor: preview.nextRenewalAmountCents,
          renewalAmountMinor: preview.nextRenewalAmountCents,
          currency: preview.currency.toUpperCase(),
          interval: preview.billingInterval,
          expiresAt: preview.expiresAt,
          card: null,
          methods: ['card'],
        },
      }
    } else {
      const result = quote.parse(
        await this.request('/api/me/checkout/quotes', 'POST', {
          purchaseType: 'individual',
          offer: 'subscription',
          groupId: plan.id,
          billingInterval: plan.interval,
          quantity: 1,
          ...(method === 'pix' ? { paymentMethod: 'pix' } : {}),
        }),
      ).data
      if (!result.available || !result.quoteId || !result.expiresAt)
        throw new AccountRequestError('contract_error')
      held = {
        owner,
        token: result.quoteId,
        subscription: null,
        view: {
          id: randomUUID() as TrialOfferId,
          paymentMethod: method,
          pixAvailable: result.pixAvailable,
          ...(result.pixMandateAmountMinor
            ? { pixMandateAmountMinor: result.pixMandateAmountMinor }
            : {}),
          planId: plan.id,
          name: plan.name,
          amountMinor: result.initialAmountMinor,
          renewalAmountMinor: result.renewalAmountMinor,
          currency: result.currency.toUpperCase(),
          interval: result.billingInterval,
          expiresAt: result.expiresAt,
          card: null,
          methods: result.paymentMethods,
        },
      }
    }
    if ((await this.owner()) !== owner)
      throw new AccountRequestError('request_cancelled')
    // Quotes are short-lived and bounded even if the user changes plans repeatedly.
    for (const [key, value] of this.offers)
      if (
        Date.parse(value.view.expiresAt) <= Date.now() ||
        value.owner !== owner
      )
        this.offers.delete(key)
    if (this.offers.size >= 20) {
      const oldest = this.offers.keys().next().value
      if (oldest !== undefined) this.offers.delete(oldest)
    }
    this.offers.set(held.view.id, held)
    return held.view
  }
  /**
   * Authorize one displayed offer; concurrent clicks join the original request.
   * @param offerId - opaque identifier from this Host's quote cache.
   * @param method - the method displayed in that offer.
   * @param requestId - original request identity, preserved after a lost response.
   * @returns the server-confirmed state or original provider handoff.
   */
  async confirm(
    offerId: TrialOfferId,
    method: 'card' | 'pix',
    requestId: TrialAttemptId,
  ): Promise<TrialPayment> {
    z.uuid().parse(requestId)
    const held = this.offers.get(offerId)
    if (
      !held ||
      held.owner !== (await this.owner()) ||
      !held.view.methods.includes(method) ||
      held.view.paymentMethod !== method
    )
      throw new AccountRequestError('contract_error')
    if (held.requestId !== undefined && held.requestId !== requestId)
      throw new AccountRequestError('contract_error')
    if (held.payment) return held.payment
    if (held.pending) return held.pending
    if (Date.parse(held.view.expiresAt) <= Date.now())
      throw new AccountRequestError('contract_error')
    held.requestId = requestId
    held.pending = this.pay(held, method, requestId)
    try {
      held.payment = await held.pending
      return held.payment
    } finally {
      delete held.pending
    }
  }
  private async pay(
    held: HeldOffer,
    method: 'card' | 'pix',
    requestId: TrialAttemptId,
  ): Promise<TrialPayment> {
    let payment: TrialPayment
    if (held.changePreview) {
      const preview = held.changePreview
      const result = z
        .object({
          data: z.object({
            status: z.literal('completed'),
            operationId: z.uuid(),
          }),
        })
        .parse(
          await this.request(
            `/api/me/subscriptions/${preview.subscription}/change-plan`,
            'POST',
            {
              targetGroupId: held.view.planId,
              targetBillingInterval: held.view.interval,
              removeConcurrencyTier: false,
              previewToken: preview.token,
            },
            preview.operationId,
          ),
        ).data
      if (result.operationId !== preview.operationId)
        throw new AccountRequestError('contract_error')
      // Moving a trial is not payment. Fetch the target's exact conversion quote for another explicit confirmation.
      payment = { status: 'reconfirm', attemptId: null, url: null }
    } else if (held.kind === 'free_tokens') {
      const result = z
        .object({
          data: z.object({
            state: z.enum([
              'converted',
              'activating',
              'checkout_required',
              'pending_payment',
            ]),
            attemptId: z.uuid().transform(value => value as TrialAttemptId).optional(),
            checkoutUrl: z.string().optional(),
          }),
        })
        .parse(
          await this.request(
            '/api/me/free-tokens/activate',
            'POST',
            { token: held.token },
            requestId,
          ),
        ).data
      payment = {
        status:
          result.state === 'converted'
            ? 'completed'
            : result.checkoutUrl
              ? 'requires_action'
              : 'pending',
        attemptId: result.attemptId ?? null,
        url: result.checkoutUrl ? paymentURL(result.checkoutUrl) : null,
      }
    } else if (held.subscription !== null) {
      const path = `/api/me/subscriptions/${held.subscription}/trial-conversion/card/`
      const body = {
        billingInterval: held.view.interval,
        conversionToken: held.token,
      }
      if (held.view.card === null) {
        const response = z
          .object({ data: z.object({ url: z.string() }) })
          .parse(
            await this.request(path + 'setup', 'POST', body, requestId),
          ).data
        payment = {
          status: 'setup_required',
          attemptId: null,
          url: paymentURL(response.url),
        }
      } else {
        const response = z
          .object({
            data: z.object({
              status: z.enum(['completed', 'requires_action', 'pending']),
              attemptId: z.uuid().transform(value => value as TrialAttemptId),
              hostedInvoiceUrl: z.string().optional(),
            }),
          })
          .parse(
            await this.request(path + 'confirm', 'POST', body, requestId),
          ).data
        payment = {
          status: response.status,
          attemptId: response.attemptId,
          url: response.hostedInvoiceUrl
            ? paymentURL(response.hostedInvoiceUrl)
            : null,
        }
      }
    } else {
      const response = z
        .object({
          data: z.object({
            mode: z.literal('stripe'),
            attemptId: z.uuid().transform(value => value as TrialAttemptId),
            url: z.string(),
          }),
        })
        .parse(
          await this.request(
            `/api/me/groups/${held.view.planId}/checkout`,
            'POST',
            {
              ...(method === 'pix' ? { quotedPaymentMethod: 'pix' } : {}),
              checkoutQuoteId: held.token,
              requestId,
              purchaseIntent: 'new',
              paymentMethod: 'stripe',
              billingInterval: held.view.interval,
              subscribeNow: true,
            },
            requestId,
          ),
        ).data
      payment = {
        status: 'requires_action',
        attemptId: response.attemptId,
        url: paymentURL(response.url),
      }
    }
    if ((await this.owner()) !== held.owner)
      throw new AccountRequestError('request_cancelled')
    return payment
  }
}
