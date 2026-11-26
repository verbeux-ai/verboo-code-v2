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
  priceCents: number
  currency: string
  interval: string
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
  billing: { amountMinor: number; currency: string; interval: string } | null
}
/** Owned subscriptions and the public purchasable plan catalog. */
export interface Plans {
  subscriptions: Subscription[]
  catalog: Plan[]
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
  | 'request_failed'
  | 'quote_changed'
  | 'contract_error'
/** A product API response whose failure never exposes credentials. */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; code: ProductError }

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
