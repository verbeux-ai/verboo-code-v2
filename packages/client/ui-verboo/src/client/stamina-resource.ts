/** Account-owned stamina reads share the standard resource cache and cancellation. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProductError } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ResourceProtocolMap, ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ProductSnapshot } from './model.ts'
import { pollAccountResource } from './polled-resource.ts'
import type {} from './contracts.ts'

type StaminaAccount = Pick<ProductSnapshot, 'view' | 'profile'>
/** One frame a stamina provider yields. */
type StaminaFrame = RemoteResult<ResourceProtocolMap['verboo-stamina']>

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
      open: (address, { signal }) => pollAccountResource(read, {
        signal,
        intervalMs,
        refreshers,
        owned: () => address !== '' && staminaAddress(account.getSnapshot()) === address,
        subscribe: onChange => account.subscribe(onChange),
        offline: () => ({
          ok: false,
          error: new RemoteError('verboo/stamina-unavailable', 'Stamina refresh is paused while offline.', { reason: 'offline' }),
        }),
        failed: () => ({
          ok: false,
          error: new RemoteError('verboo/stamina-unavailable', 'Stamina refresh is unavailable.', { reason: 'contract_error' }),
        }),
        interpret: (result): readonly StaminaFrame[] => {
          if (!result.ok) return [result]
          if (!result.value.ok) {
            return [{
              ok: false,
              error: new RemoteError('verboo/stamina-unavailable', 'Stamina could not be refreshed.', { reason: result.value.code }),
            }]
          }
          return [{ ok: true, value: result.value.data }]
        },
      }),
    },
  }
}
