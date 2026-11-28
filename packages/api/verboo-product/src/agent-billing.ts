/** Host-only contract for financial actions initiated in a conversation. */
import type {
  BillingInterval, BillingSubscriptionId, PlanChangeId, PlanChangeProgress, PlanChangeQuote, PlanId,
  Plans, Result, Subscription, SubscriptionLifecycleProgress,
} from './types.ts'

/** One prepared plan change. The authorization itself stays in the Host closure. */
export interface PreparedAgentPlanChange {
  readonly quote: PlanChangeQuote
  /** Apply this exact offer once, following a decision from the approval service. */
  confirm(signal: AbortSignal): Promise<Result<{ progress: PlanChangeProgress; submitted: boolean }>>
}

/** Commerce operations fenced to the login that opened this capability. */
export interface AgentBilling {
  /** Resolve whether the captured authentication and account still match. */
  isCurrent(): Promise<boolean>
  /** Wait for authentication to change, until aborted by the caller. */
  watchOwner(signal: AbortSignal): Promise<boolean>
  /** Read the current account's plans and the public catalog. */
  plans(signal: AbortSignal): Promise<Result<Plans>>
  /** Prepare the exact target without any financial effect. */
  quoteChange(
    subscription: BillingSubscriptionId, plan: PlanId, interval: BillingInterval, signal: AbortSignal,
  ): Promise<Result<PreparedAgentPlanChange>>
  /** Cancel the reviewed subscription only if its material facts still match. */
  cancel(reviewed: Subscription, locale: string | undefined, signal: AbortSignal): Promise<Result<SubscriptionLifecycleProgress>>
  /** Read a specific plan change, or recover the one belonging to this subscription. */
  changeStatus(
    subscription: Subscription, operation: PlanChangeId | undefined, signal: AbortSignal,
  ): Promise<Result<PlanChangeProgress | null>>
  /** Recover the original cancellation, including a response lost after submission. */
  cancellationStatus(subscription: BillingSubscriptionId, signal: AbortSignal): Promise<Result<SubscriptionLifecycleProgress | null>>
}
