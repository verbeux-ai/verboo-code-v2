/**
 * External subscription limits (ChatGPT/Codex) share the standard resource
 * cache, cancellation, and account scoping with account stamina. The reading
 * belongs to the accepted composer route's provider, never to a display name.
 */
import type { ProductError } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ResourceProtocolMap, ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ProductSnapshot } from './model.ts'
import type {} from './contracts.ts'
import type { SubscriptionUsage } from '@deepseek-ai/dsh-api-remotes/client'
import { pollAccountResource } from './polled-resource.ts'
export type { SubscriptionUsage } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Provider routing slug of the ChatGPT subscription route. The Client never
 * infers subscription identity from a model's display name.
 */
export const CODEX_PROVIDER = 'openai-codex'

/** Usage thresholds that make the composer pill visible at all. */
const WARN_PERCENT = 80

/** Visible presentation state of one reading; `unavailable` renders nothing. */
export type SubscriptionUsageState = 'normal' | 'warn' | 'exhausted' | 'unlimited' | 'unavailable'

type UsageAccount = Pick<ProductSnapshot, 'view' | 'profile'>
/** One frame a subscription-usage provider yields. */
type UsageFrame = RemoteResult<ResourceProtocolMap['verboo-subscription-usage']>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'verboo/subscription-usage-unavailable': { reason: ProductError | 'offline' | 'unreported' }
  }
}

/**
 * Select an account-specific cache address without putting credentials on the Client.
 * @param account - current authenticated presenter snapshot.
 * @returns an empty address while signed out or awaiting the current account profile.
 */
export function subscriptionUsageAddress(account: UsageAccount): string {
  const revision = account.view?.credentialRevision
  return account.view?.status === 'credential-stored' && revision !== undefined && account.profile !== null && account.profile.id !== null
    ? `dsh-resource://verboo-subscription-usage/${encodeURIComponent(revision)}/${encodeURIComponent(account.profile.id)}`
    : ''
}

/**
 * Classify one reading for presentation. A missing reading is unavailable, never
 * zero percent and never a filled bar; `unlimited` comes only from the reading.
 * @param usage - the latest confirmed reading, or undefined when none exists.
 * @returns the presentation state.
 */
export function subscriptionUsageState(usage: SubscriptionUsage | undefined): SubscriptionUsageState {
  if (usage === undefined) return 'unavailable'
  if (usage.unlimited) return 'unlimited'
  if (usage.reachedType != null || usage.usedPercent >= 100) return 'exhausted'
  return usage.usedPercent >= WARN_PERCENT ? 'warn' : 'normal'
}

/**
 * Whether the reading is worth a composer control at all: the healthy window
 * stays silent so the dock keeps its resting height.
 * @param state - classified presentation state.
 * @returns true for the states the pill presents.
 */
export function subscriptionUsageVisible(state: SubscriptionUsageState): boolean {
  return state === 'warn' || state === 'exhausted' || state === 'unlimited'
}

/**
 * Build one provider for the product plugin lifetime. Hidden/offline windows stop reads;
 * account changes abort the old read, and the resource registry retains the last valid value after failures.
 * @param read - generated Host method; authentication stays on the Host.
 * @param account - current account identity, read through its existing observable.
 * @param intervalMs - configured delay after each completed visible-window read.
 * @returns the owned provider and a refresh command shared by its mounted views.
 */
export function createSubscriptionUsageResource(
  read: (signal?: AbortSignal) => Promise<RemoteResult<SubscriptionUsage | undefined>>,
  account: ObservableSnapshot<UsageAccount>,
  intervalMs: number,
): { provider: ResourceProvider<'verboo-subscription-usage'>; refresh(): void } {
  const refreshers = new Set<() => void>()
  return {
    refresh() {
      for (const refresh of refreshers) refresh()
    },
    provider: {
      protocol: 'verboo-subscription-usage',
      open: (address, { signal }) => pollAccountResource(read, {
        signal,
        intervalMs,
        refreshers,
        owned: () => address !== '' && subscriptionUsageAddress(account.getSnapshot()) === address,
        subscribe: onChange => account.subscribe(onChange),
        offline: () => ({
          ok: false,
          error: new RemoteError('verboo/subscription-usage-unavailable', 'Subscription usage refresh is paused while offline.', { reason: 'offline' }),
        }),
        failed: () => ({
          ok: false,
          error: new RemoteError('verboo/subscription-usage-unavailable', 'Subscription usage refresh is unavailable.', { reason: 'contract_error' }),
        }),
        interpret: (result): readonly UsageFrame[] => {
          if (!result.ok) return [result]
          if (result.value === undefined) {
            // No reading is display data, not a failure: the control stays
            // absent rather than painting a number the provider never gave.
            return [{
              ok: false,
              error: new RemoteError('verboo/subscription-usage-unavailable', 'Subscription usage is unavailable.', { reason: 'unreported' }),
            }]
          }
          return [{ ok: true, value: result.value }]
        },
      }),
    },
  }
}
