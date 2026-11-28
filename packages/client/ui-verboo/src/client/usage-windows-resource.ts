/** Read account allowance only while the Plans page has a visible reader. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProductError, UsageWindowsStatus } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ProductSnapshot } from './model.ts'
import { pollAccountResource } from './polled-resource.ts'

type Account = Pick<ProductSnapshot, 'profile' | 'view'>
type Failure = ProductError | 'offline'
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'verboo/usage-windows-unavailable': { reason: Failure }
  }
}

/**
 * Scope the allowance resource to the account and its accepted credential revision.
 * @param account - the current profile and credential view.
 * @returns the resource URI or an empty string when no account is available.
 */
export function usageWindowsAddress(account: Account): string {
  const { view, profile } = account
  return view?.status === 'credential-stored' && view.credentialRevision !== undefined && profile?.id != null
    ? `dsh-resource://verboo-usage-windows/${encodeURIComponent(view.credentialRevision)}/${encodeURIComponent(profile.id)}`
    : ''
}

/**
 * Poll the current account allowance while the Plans page has a reader.
 * @param read - the remote allowance reader.
 * @param account - the observed account and credential source.
 * @param intervalMs - the delay between successive polls in milliseconds.
 * @returns the account-scoped resource provider and an explicit refresh command.
 */
export function createUsageWindowsResource(read: ClientRemote['verboo']['getUsageWindows'],
  account: ObservableSnapshot<Account>, intervalMs: number): { provider: ResourceProvider<'verboo-usage-windows'>; refresh(): void } {
  const refreshers = new Set<() => void>()
  const failure = (reason: Failure): RemoteResult<UsageWindowsStatus[]> => ({
    ok: false, error: new RemoteError('verboo/usage-windows-unavailable', 'Allowance refresh is unavailable.', { reason }),
  })
  return {
    refresh: () => { for (const refresh of refreshers) refresh() },
    provider: {
      protocol: 'verboo-usage-windows',
      open: (address, { signal }) => pollAccountResource(read, {
        signal, intervalMs, refreshers,
        owned: () => address !== '' && usageWindowsAddress(account.getSnapshot()) === address,
        subscribe: onChange => account.subscribe(onChange),
        offline: () => failure('offline'),
        failed: () => failure('contract_error'),
        interpret: result => !result.ok ? [result] : result.value.ok
          ? [{ ok: true, value: result.value.data }]
          : [failure(result.value.code)],
      }),
    },
  }
}
