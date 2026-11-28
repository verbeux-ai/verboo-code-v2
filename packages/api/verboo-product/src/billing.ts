/** Verboo commerce response decoders and durable checkout identity. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { AccountRequestError } from '@deepseek-ai/dsh-verboo-account'
import { paymentURL } from './trial.ts'
import type {
  BillingQuoteId, BillingSubscriptionId, PlanChangeId, PlanId, PurchaseAttemptId,
  PlanChangeProgress, PurchaseProgress,
} from './types.ts'

const billingDate = z.iso.datetime({ offset: true })
/** Accepted recurrence values for signed offers. */
export const billingPeriod = z.enum(['month', 'year'])
const currency = z.string().regex(/^[A-Za-z]{3}$/)
/** Locally issued handle for an authorization kept in the Host. */
export const offerId = z.uuid().transform(id => id as BillingQuoteId)
const groupId = z.uuid().transform(id => id as PlanId)
/** Server ID of a subscription owned by the authenticated account. */
export const billingSubscriptionId = z.uuid().transform(id => id as BillingSubscriptionId)
/** Server ID of a purchase attempt. */
export const purchaseId = z.uuid().transform(id => id as PurchaseAttemptId)
/** Server ID of one plan change. */
export const planChangeId = z.uuid().transform(id => id as PlanChangeId)
/** Server recommendation for a plan and the account’s existing contracts. */
export const purchaseOptions = z.object({
  version: z.literal(1),
  groupId,
  billingInterval: billingPeriod,
  additionalAllowed: z.boolean(),
  recommendation: z.enum(['checkout', 'choose', 'change', 'manage', 'convert', 'resume', 'recover', 'support']),
  subscriptions: z.array(z.object({
    subscriptionId: billingSubscriptionId,
    action: z.enum(['checkout', 'choose', 'change', 'manage', 'convert', 'resume', 'recover', 'support']),
    attemptId: purchaseId.optional(),
  })).max(500),
})
/** Server quote for an individual subscription or a typed unavailable result. */
export const checkoutQuote = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    groupId,
    billingInterval: billingPeriod,
    purchaseType: z.literal('individual'),
    offer: z.literal('subscription'),
    quantity: z.literal(1),
    quoteId: z.string().min(1).max(8192),
    initialAmountMinor: z.number().int().nonnegative(),
    renewalAmountMinor: z.number().int().nonnegative(),
    currency,
    paymentMethods: z.array(z.enum(['card', 'pix'])),
    expiresAt: billingDate,
  }),
  z.object({ available: z.literal(false) }),
])
/** Initial checkout result, including an existing subscription reactivation. */
export const checkoutHandoff = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('stripe'), attemptId: purchaseId, url: z.string() }),
  z.object({ mode: z.literal('reactivated') }),
])
/** Persisted status and offer identity of an individual subscription checkout. */
export const purchaseAttempt = z.object({
  id: purchaseId, groupId, billingInterval: billingPeriod, kind: z.literal('subscription'),
  provider: z.string().optional(), errorCode: z.string().nullish(), checkoutReferenceKnown: z.boolean().optional(),
  status: z.enum(['pending', 'requires_action', 'succeeded', 'failed', 'expired', 'review']),
})
/** Authoritative payment collection, projection status, and access end date. */
export const cancellation = z.object({
  collectionStatus: z.string(), localStatus: z.string(), accessUntil: billingDate.nullable(),
  operationId: z.uuid().optional(),
})
/** Invoice fields safe for the authenticated subscription view. */
export const invoices = z.array(z.object({
  id: z.string(), number: z.string(), created: billingDate,
  amountDue: z.number().int(), amountPaid: z.number().int(), currency, status: z.string(),
  hostedInvoiceUrl: z.string().optional(),
})).max(500)
/** Signed price, timing, and scope for a specific plan change. */
export const changePreview = z.object({
  policyVersion: z.literal(2),
  operationId: planChangeId,
  previewToken: z.string().min(1).max(8192),
  billingInterval: billingPeriod,
  currency,
  amountDueNowCents: z.number().int(),
  creditNowCents: z.number().int(),
  nextRenewalAmountCents: z.number().int(),
  nextRenewalAt: billingDate,
  effectiveAt: billingDate,
  expiresAt: billingDate,
  undoesCancellation: z.boolean(),
  removesConcurrencyTier: z.boolean(),
  concurrencyTierId: z.uuid().optional(),
  pixAuthorizationRequired: z.boolean(),
  pixMandateAmountCents: z.number().int().nonnegative().optional(),
})
/** Persisted plan-change state and optional provider continuation. */
export const changeProgress = z.object({
  operationId: planChangeId,
  targetGroupId: groupId.optional(),
  status: z.string().min(1),
  effectiveAt: billingDate.nullish(),
  hostedInvoiceUrl: z.string().optional(),
  authorizationUrl: z.string().optional(),
})
/** Account-local record for replaying the exact unconfirmed checkout request. */
export const purchaseRecovery = z.object({
  planId: groupId, interval: billingPeriod,
  requestId: purchaseId, attemptId: purchaseId,
  journeyId: z.uuid(), operationId: z.uuid(),
  originalBody: z.string().max(12000).optional(), quoteExpiresAt: billingDate.optional(),
  closedUnstarted: z.literal(true).optional(),
})

/** Actions that can change renewal on a single subscription. */
export const lifecycleAction = z.enum(['cancel', 'reactivate'])
/** Original lifecycle write and the authoritative cancellation result it belongs to. */
export const lifecycleRecovery = z.object({
  action: lifecycleAction, operationId: z.uuid(), requestId: z.uuid(), journeyId: z.uuid(),
  baselineCancellationId: z.uuid().optional(), cancellation: cancellation.optional(),
})

const changeRecovery = z.object({ id: planChangeId, operationId: z.uuid(), requestId: z.uuid(), journeyId: z.uuid() })

/** Retain commerce identities and the exact short-lived card authorization on the Host. */
export const purchaseDomain = defineDomain({
  name: 'verboo_purchase_recovery', version: 1, layout: 'per-record',
  tables: {
    purchases: domainTable<string, z.infer<typeof purchaseRecovery>>(purchaseRecovery),
    changes: domainTable<string, z.infer<typeof changeRecovery>>(changeRecovery),
    lifecycles: domainTable<string, z.infer<typeof lifecycleRecovery>>(lifecycleRecovery),
  },
})

/**
 * Decode an authenticated Verboo response envelope.
 * @param schema - expected data fields.
 * @param response - decoded HTTP body.
 * @returns verified response data.
 */
export function billingData<T>(schema: z.ZodType<T>, response: unknown): T {
  return z.object({ data: schema }).parse(response).data
}

/**
 * Check that the provider step belongs to the exact requested change.
 * @param changed - server operation.
 * @param id - expected operation identifier.
 * @returns display-safe progress.
 */
export function planChangeProgress(changed: z.infer<typeof changeProgress>, id: PlanChangeId): PlanChangeProgress {
  if (changed.operationId !== id) throw new AccountRequestError('contract_error')
  const url = changed.authorizationUrl || changed.hostedInvoiceUrl
  return { id, status: changed.status, effectiveAt: changed.effectiveAt ?? null, url: url ? paymentURL(url) : null }
}

/**
 * Project an exact attempt without using a browser return as a payment result.
 * @param attempt - authenticated server record.
 * @returns display-safe attempt state.
 */
export function purchaseProgress(attempt: z.infer<typeof purchaseAttempt>): PurchaseProgress {
  const uncertainProvider = attempt.provider === 'stripe' && attempt.status === 'failed' &&
    attempt.errorCode === 'checkout_provider_unavailable' && attempt.checkoutReferenceKnown !== true
  const status = attempt.errorCode === 'checkout_abandoned' && attempt.status === 'failed' ? 'abandoned' :
    uncertainProvider ? 'pending' : attempt.status
  return {
    id: attempt.id, planId: attempt.groupId, interval: attempt.billingInterval,
    status,
    url: null,
    ...(['pending', 'requires_action', 'failed'].includes(status) &&
      ['card_declined', 'insufficient_funds', 'invoice_payment_failed'].includes(attempt.errorCode ?? '') ? { declined: true } : {}),
    canAbandon: attempt.provider === 'stripe' && ['pending', 'requires_action'].includes(status),
  }
}
