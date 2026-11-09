/** Safe product projections. OAuth grants and Composio credentials are Host/server-only. */
import type { Branded } from '@deepseek-ai/dsh-brand'
/** Opaque identity of one user-owned Composio connection. */
export type ConnectionId = Branded<'VerbooConnectionId'>
/** Opaque identifier of a Verboo plan. */
export type PlanId = Branded<'VerbooPlanId'>
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
  | 'contract_error'
/** A product API response whose failure never exposes credentials. */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; code: ProductError }
