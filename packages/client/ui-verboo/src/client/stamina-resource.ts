/** Account-owned stamina reads share the standard resource cache and cancellation. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProductError } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ProductSnapshot } from './model.ts'
import type {} from './contracts.ts'

type StaminaAccount = Pick<ProductSnapshot, 'view' | 'profile'>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'verboo/stamina-unavailable': { reason: ProductError | 'offline' }
  }
}

/**
 * Select an account-specific cache address without putting credentials on the Client.
 * @param account - current authenticated presenter snapshot.
 * @returns an empty address while signed out or awaiting the current account profile.
 */
export function staminaAddress(account: StaminaAccount): string {
  const revision = account.view?.credentialRevision
  return account.view?.status === 'credential-stored' && revision !== undefined && account.profile !== null && account.profile.id !== null
    ? `dsh-resource://verboo-stamina/${encodeURIComponent(revision)}/${encodeURIComponent(account.profile.id)}`
    : ''
}

/**
 * Build one provider for the product plugin lifetime. Hidden/offline windows stop reads;
 * account changes abort the old read, and the resource registry retains the last valid value after failures.
 * @param read - generated Host method; authentication stays on the Host.
 * @param account - current account identity, read through its existing observable.
 * @param intervalMs - configured delay after each completed visible-window read.
 * @returns the owned provider and a refresh command shared by its mounted views.
 */
export function createStaminaResource(
  read: ClientRemote['verboo']['getStamina'],
  account: ObservableSnapshot<StaminaAccount>,
  intervalMs: number,
): { provider: ResourceProvider<'verboo-stamina'>; refresh(): void } {
  const refreshers = new Set<() => void>()
  return {
    refresh() {
      for (const refresh of refreshers) refresh()
    },
    provider: {
      protocol: 'verboo-stamina',
      async *open(address, { signal }) {
        let pending: AbortController | undefined
        let resume: (() => void) | undefined
        let dirty = false
        const aborted = () => signal.aborted
        const owned = () => address !== '' && staminaAddress(account.getSnapshot()) === address
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
              yield { ok: false, error: new RemoteError('verboo/stamina-unavailable', 'Stamina refresh is paused while offline.', { reason: 'offline' }) }
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
                yield { ok: false, error: new RemoteError('verboo/stamina-unavailable', 'Stamina could not be refreshed.', { reason: result.value.code }) }
              } else yield { ok: true, value: result.value.data }
            } catch (_error) {
              if (aborted() || !owned()) return
              if (!visible() || !online()) continue
              yield { ok: false, error: new RemoteError('verboo/stamina-unavailable', 'Stamina refresh is unavailable.', { reason: 'contract_error' }) }
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
