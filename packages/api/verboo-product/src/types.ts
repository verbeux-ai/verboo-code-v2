/** Safe product projections. OAuth grants and Composio credentials are Host/server-only. */
import type { Branded } from '@deepseek-ai/dsh-brand'
/** Opaque identity of one user-owned Composio connection. */
export type ConnectionId = Branded<'VerbooConnectionId'>
/** Opaque identifier of a Verboo plan. */
export type PlanId = Branded<'VerbooPlanId'>
/** Opaque server trial notice identity, including token-grant notices. */
export type TrialId = Branded<'VerbooTrialId'>
/** Opaque identity of one Host-owned display offer. */
export type TrialOfferId = Branded<'VerbooTrialOfferId'>
/** Opaque purchase operation or attempt identity retained for recovery. */
export type TrialAttemptId = Branded<'VerbooTrialAttemptId'>
/** Public recurring plan available for acquisition. */
export interface Plan {
  id: PlanId
  name: string
  /** Server routing slug; absent on older API projections. */
  slug?: string
  description: string
  priceCents: number | null
  currency: string | null
  interval: string
  /** Set when the server lists the group without an acquisition offer. */
  unavailable?: true
  /** Server-reported limits and model catalog; omitted when unavailable. */
  usageLimitsEnabled?: boolean
  concurrentRequests?: number
  apiRateLimitRpm?: number
  apiAccessEnabled?: boolean
  structuredOutputEnabled?: boolean
  enableRanking?: boolean
  seatPurchasesEnabled?: boolean
  models?: { name: string; temporary: boolean }[]
}
/** Server-authoritative subscription information for one account. */
export interface Subscription {
  id: string
  planId: PlanId
  name: string
  /** Server routing slug of this subscription's group. */
  slug?: string
  status: string
  renewsAt: string | null
  cancelAtEnd: boolean
  canUpgrade: boolean
  limitedUsage?: { concurrentRequests?: number; apiRateLimitRpm?: number }
  permissions?: SubscriptionPermissions
  activeChangeId?: PlanChangeId
  canRemoveTier?: boolean
  cancellation?: SubscriptionCancellation
  billing: { amountMinor: number; currency: string; interval: string } | null
}
/** Owned subscriptions and the public purchasable plan catalog. */
export interface Plans {
  subscriptions: Subscription[]
  catalog: Plan[]
}
/** Display-safe allowance state, without internal budgets or billing inputs. */
export interface UsageWindowsStatus {
  groupId: PlanId
  groupName: string
  limited: boolean
  blocked: boolean
  accountingPending: boolean
  availableAt: string | null
  windows: { id: string; durationSeconds: number; usedPercent: number; resetsAt: string | null }[]
}
/** Public stamina for one enrolled plan. Budgets, tariffs and costs stay on the server. */
export interface StaminaStatus {
  groupId: PlanId
  groupName: string
  remainingPercent: number
  nextOutputTps: number
  recovering: boolean
  fullAt: string | null
  accountingPending: boolean
  asOf: string
}
/** Server-defined historical usage periods available in the account dashboard. */
export type UsagePeriod = '24h' | '7d' | '30d' | 'current_month' | 'previous_month'
/** One server-grouped usage bucket. */
export interface UsageBucket { bucket: string; reqCount: number; tokensIn: number; tokensOut: number; cachedTokens: number }
/** Historical subscription usage, preserving the server timezone and bucket. */
export interface UsageSummary {
  timezone: string
  bucket: 'minute' | 'hour' | 'day'
  reqTotal: number
  tokensInTotal: number
  tokensOutTotal: number
  cachedTokens: number
  buckets: UsageBucket[]
}
/** One activity day from the authoritative usage calendar. */
export interface UsageActivityDay { date: string; count: number }

/** Credential-free identity and authorization state for an external account. */
export interface Connection {
  id: ConnectionId
  toolkit: string
  label: string
  status:
    | 'connected'
    | 'pending'
    | 'expired'
    | 'failed'
    | 'disconnected'
    | 'unknown'
}
/** One public Composio service; availability reflects its server-side authentication setup. */
export interface Toolkit {
  slug: string
  name: string
  available: boolean
  /** Absolute URL of the service's brand mark, when the catalog carries one. */
  logo?: string | undefined
  authType?: 'oauth' | 'credentials' | 'none' | 'setup' | undefined
}
/** The authenticated user’s external accounts and enabled services. */
export interface Connections {
  available: boolean
  toolkits: Toolkit[]
  accounts: Connection[]
}
/** Fixed product API failure categories without upstream response bodies. */
export type ProductError =
  | 'signed_out'
  | 'account_changed'
  | 'unavailable'
  | 'not_found'
  | 'terms_required'
  | 'request_failed'
  | 'quote_changed'
  | 'checkout_rejected'
  | 'contract_error'
/** A product API response whose failure never exposes credentials. */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; code: ProductError }

/** Account settings returned by the authenticated profile endpoint. */
export interface ProfileSettings {
  id: string
  name: string
  email: string
  hasPassword: boolean
  publicProfile: boolean
  anonymousHandle?: string | undefined
}

/** Password failures never include provider messages or password values. */
export type PasswordResult = { ok: true } | { ok: false; code: 'incorrect_password' | 'failed' }

/** Server-decided trial attention, scoped to the group whose access is ending. */
export interface TrialNotice {
  id: TrialId
  groupId: PlanId
  source: 'free_tokens' | 'trial' | 'stripe_trial'
  state: 'ending' | 'ended'
  endsAt?: string | undefined
  tokensRemaining?: number | undefined
  tokenLimit?: number | undefined
}
/** A timestamped authoritative snapshot; errors are never an ended trial. */
export interface TrialStatus { asOf: string; trials: TrialNotice[]; paidGroupIds?: PlanId[] }
/** Display-only commercial offer. Signed provider quotes remain on the Host. */
export interface TrialOffer {
  attemptId?: TrialAttemptId
  pending?: TrialPayment
  paymentMethod: 'card' | 'pix'
  pixAvailable: boolean
  pixMandateAmountMinor?: number
  id: TrialOfferId
  planId: PlanId
  name: string
  amountMinor: number
  renewalAmountMinor: number
  currency: string
  interval: 'month' | 'year'
  expiresAt: string
  card: { brand: string; last4: string } | null
  methods: ('card' | 'pix')[]
}
/** A provider return is a navigation instruction, never proof of payment. */
export interface TrialPayment {
  status: 'pending' | 'requires_action' | 'completed' | 'setup_required' | 'reconfirm'
  attemptId: TrialAttemptId | null
  url: string | null
}
/** A server measurement of generation speed, scoped to the signed-in account. */
export interface SpeedMeasurement { value: number; quality: 'measured' | 'estimated'; partial: boolean; at: string; previous: boolean }
/** A safe live speed projection; account credentials and concurrency stay on the Host. */
export interface SpeedFrame { at: string; stale: boolean; measurement: SpeedMeasurement | null }

/** Billing period accepted by the commerce API. */
export type BillingInterval = 'month' | 'year'
/** Opaque identity of a server subscription. */
export type BillingSubscriptionId = Branded<'BillingSubscriptionId'>
/** Opaque identity of a saved purchase attempt. */
export type PurchaseAttemptId = Branded<'PurchaseAttemptId'>
/** Opaque identity of a quoted billing action. */
export type BillingQuoteId = Branded<'BillingQuoteId'>
/** Next action recommended for the selected plan and account. */
export interface PurchaseRecommendation {
  action: 'checkout' | 'choose' | 'change' | 'manage' | 'convert' | 'resume' | 'recover' | 'support'
  subscriptions: {
    subscriptionId: BillingSubscriptionId
    action: PurchaseRecommendation['action']
    attemptId?: PurchaseAttemptId
  }[]
}
/** Checkout quote with authorization retained on the Host. */
export interface PurchaseQuote {
  id: BillingQuoteId
  planId: PlanId
  interval: BillingInterval
  initialAmountMinor: number
  renewalAmountMinor: number
  currency: string
  expiresAt: string
}
/** Status of the original purchase, as known by the server. */
export interface PurchaseProgress {
  id: PurchaseAttemptId
  planId: PlanId
  interval: BillingInterval
  status: 'unconfirmed' | 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'expired' | 'review' | 'reactivated' | 'abandoned'
  url: string | null
  canRetry?: boolean
  canAbandon?: boolean
  closedUnstarted?: boolean
  declined?: boolean
}
/** Actions explicitly enabled by the server for this subscription owner. */
export interface SubscriptionPermissions {
  cancel: boolean
  reactivate: boolean
  invoices: boolean
  paymentMethod: boolean
  cardUpdate?: boolean
}
/** Status of card setup for one subscription, with a validated handoff when available. */
export interface SubscriptionCardUpdate {
  id: string
  status: 'pending' | 'confirmed' | 'failed' | 'expired'
  url: string | null
  embedded?: EmbeddedCardSetup
}
/** Bootstrap data for opening Stripe card setup in the native window. */
export interface EmbeddedCardSetup {
  url: string
  clientSecret: string
  publishableKey: string
}
/** Durable cancellation result, including access through the paid cycle. */
export interface SubscriptionCancellation {
  collectionStatus: string
  localStatus: string
  accessUntil: string | null
  operationId?: string | undefined
}
/** Evidence of a lifecycle action on the selected subscription. */
export interface SubscriptionLifecycleProgress {
  action: 'cancel' | 'reactivate'
  status: 'unconfirmed' | 'pending' | 'confirmed' | 'reconciliation_required'
  cancellation: SubscriptionCancellation | null
}
/** One display-safe invoice belonging to the selected subscription. */
export interface SubscriptionInvoice {
  id: string
  number: string
  created: string
  amountDue: number
  amountPaid: number
  currency: string
  status: string
  url: string | null
}
/** Signed plan-change preview projected for display. */
export interface PlanChangeQuote {
  id: BillingQuoteId
  subscriptionId: BillingSubscriptionId
  targetPlanId: PlanId
  interval: BillingInterval
  currency: string
  amountDueNowCents: number
  creditNowCents: number
  nextRenewalAmountCents: number
  nextRenewalAt: string
  effectiveAt: string
  expiresAt: string
  undoesCancellation: boolean
  removesConcurrencyTier: boolean
  pixMandateAmountCents?: number
}
/** Opaque identity of a signed plan-change operation. */
export type PlanChangeId = Branded<'PlanChangeId'>
/** Server-confirmed progress of a change, or its identity during an uncertain write. */
export interface PlanChangeProgress {
  id: PlanChangeId
  status: string
  effectiveAt: string | null
  url: string | null
}
