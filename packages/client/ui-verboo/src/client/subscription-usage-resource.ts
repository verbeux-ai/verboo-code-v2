/**
 * External subscription limits (ChatGPT/Codex) share the standard resource
 * cache, cancellation, and account scoping with account stamina. The reading
 * belongs to the accepted composer route's provider, never to a display name.
 */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProductError, Result } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ProductSnapshot } from './model.ts'
import type {} from './contracts.ts'

/** One server reading of an external subscription's usage window. */
export interface SubscriptionUsage {
  /** Share of the current window already consumed, in percent. */
  usedPercent: number
  /** Length of the usage window in seconds; null when the provider reports none. */
  windowSeconds: number | null
  /** Seconds until the window resets; null when unknown. */
  resetAfterSeconds: number | null
  /** Remaining provider credits; null when the provider reports none. */
  credits: number | null
  /** Whether the provider reports the plan as unlimited; never inferred locally. */
  unlimited: boolean
  /** Provider plan label, for example `team`; null when unknown. */
  planType: string | null
  /** ISO instant the subscription stays active until; null when unknown. */
  activeUntil: string | null
  /** Provider reason for a reached limit, for example `workspace_member_usage_limit_reached`. */
  reachedType: string | null
  /** Additional provider rate limits shown as extra rows in the panel. */
  additionalLimits: readonly { label: string; usedPercent: number }[]
  /** ISO instant of this reading. */
  asOf: string
}

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

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'verboo/subscription-usage-unavailable': { reason: ProductError | 'offline' }
  }
  /**
   * The external-subscription usage read. The Host exposes it next to
   * `getStamina`; declaring it here keeps the Client typed until the generated
   * remote face carries the method.
   */
  interface TypertRemoteNamespace$766572626f6f {
    getSubscriptionUsage: (signal?: AbortSignal) => Promise<RemoteResult<Result<SubscriptionUsage>>>
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
  if (usage.reachedType !== null || usage.usedPercent >= 100) return 'exhausted'
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
  read: ClientRemote['verboo']['getSubscriptionUsage'],
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
      async *open(address, { signal }) {
        let pending: AbortController | undefined
        let resume: (() => void) | undefined
        let dirty = false
        const aborted = () => signal.aborted
        const owned = () => address !== '' && subscriptionUsageAddress(account.getSnapshot()) === address
        const visible = () => document.visibilityState === 'visible'
        const online = () => navigator.onLine
        const notify = () => {
          dirty = true
          resume?.()
        }
        const environmentChanged = () => {
          if (aborted() || !visible() || !online() || !owned()) pending?.abort()
          notify()
        }
        const identityChanged = () => {
          if (!owned()) environmentChanged()
        }
        const wait = async (delay?: number): Promise<void> => {
          if (aborted() || dirty) {
            dirty = false
            return
          }
          await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined
            const done = () => {
              clearTimeout(timer)
              resume = undefined
              dirty = false
              resolve()
            }
            resume = done
            if (delay !== undefined) timer = setTimeout(done, delay)
          })
        }
        const stopAccount = account.subscribe(identityChanged)
        signal.addEventListener('abort', environmentChanged)
        window.addEventListener('focus', environmentChanged)
        window.addEventListener('online', environmentChanged)
        window.addEventListener('offline', environmentChanged)
        document.addEventListener('visibilitychange', environmentChanged)
        refreshers.add(notify)
        try {
          while (!aborted() && owned()) {
            if (!visible()) {
              await wait()
              continue
            }
            if (!online()) {
              yield { ok: false, error: new RemoteError('verboo/subscription-usage-unavailable', 'Subscription usage refresh is paused while offline.', { reason: 'offline' }) }
              await wait()
              continue
            }
            dirty = false
            pending = new AbortController()
            try {
              const result = await read(AbortSignal.any([signal, pending.signal]))
              if (aborted() || !owned()) return
              if (!visible() || !online()) continue
              if (!result.ok) yield result
              else if (!result.value.ok) {
                yield { ok: false, error: new RemoteError('verboo/subscription-usage-unavailable', 'Subscription usage could not be refreshed.', { reason: result.value.code }) }
              } else yield { ok: true, value: result.value.data }
            } catch (_error) {
              if (aborted() || !owned()) return
              if (!visible() || !online()) continue
              yield { ok: false, error: new RemoteError('verboo/subscription-usage-unavailable', 'Subscription usage refresh is unavailable.', { reason: 'contract_error' }) }
            } finally {
              pending = undefined
            }
            await wait(intervalMs)
          }
        } finally {
          pending?.abort()
          refreshers.delete(notify)
          stopAccount()
          signal.removeEventListener('abort', environmentChanged)
          window.removeEventListener('focus', environmentChanged)
          window.removeEventListener('online', environmentChanged)
          window.removeEventListener('offline', environmentChanged)
          document.removeEventListener('visibilitychange', environmentChanged)
          resume?.()
        }
      },
    },
  }
}
