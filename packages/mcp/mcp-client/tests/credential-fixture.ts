/** In-memory credential references for template tests; record operations are unexpected. */

import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

/** Resolves references from {@link TestCredentials.values}; every other operation throws. */
export class TestCredentials extends CredentialProvider {
  values = new Map<string, string>()

  /** Publish a rotation of one reference to every listener. */
  rotate(ref: CredentialRef | string): void { this.notifyUpdated(ref as CredentialRef) }

  /** When set, resolve rejects with this error instead of consulting the map. */
  failingResolve: Error | undefined
  /** When set, resolve delays this long before answering. */
  resolveDelayMs = 0

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (this.failingResolve !== undefined) return Promise.reject(this.failingResolve)
    if (this.resolveDelayMs > 0) {
      return new Promise(resolve => setTimeout(() => {
        const value = this.values.get(ref)
        resolve(value === undefined ? undefined : { value, source: 'fixture' })
      }, this.resolveDelayMs))
    }
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'fixture' })
  }

  describe(): Promise<CredentialInfo> { throw new Error('unexpected credential description') }
  set(): Promise<void> { throw new Error('unexpected credential write') }
  unset(): Promise<void> { throw new Error('unexpected credential removal') }
  readRecord(): Promise<CredentialRecord | undefined> { throw new Error('unexpected record read') }
  describeRecord(): Promise<CredentialRecordInfo> { throw new Error('unexpected record description') }
  listRecords(): Promise<readonly CredentialRecordEntry[]> { throw new Error('unexpected record listing') }
  modifyRecord(): Promise<CredentialRecord | undefined> { throw new Error('unexpected record write') }
  deleteRecord(): Promise<void> { throw new Error('unexpected record removal') }
}
