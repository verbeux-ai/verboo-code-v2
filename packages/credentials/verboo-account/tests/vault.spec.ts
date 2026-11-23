import { expect, it, vi } from 'vitest'
import { GrantVault } from '../src/vault.ts'

const keyring = vi.hoisted(() => new Map<string, number[]>())

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    private readonly address: string

    constructor(service: string, account: string) {
      this.address = JSON.stringify([service, account])
    }

    async getSecret(): Promise<number[] | null> {
      return keyring.get(this.address) ?? null
    }

    async setSecret(secret: Uint8Array): Promise<void> {
      keyring.set(this.address, [...secret])
    }
  },
}))

it('reuses the OS key for the same installation and refuses missing or malformed keys', async () => {
  const issuer = 'https://account.fixture.test'
  const first = new GrantVault(issuer, 'fixture-installation')
  const grant = { sessionId: 'fixture-session', refreshToken: 'fixture-refresh' }
  await first.prepare()
  const envelope = await first.seal(grant)

  const reopened = new GrantVault(issuer, 'fixture-installation')
  await expect(reopened.open(envelope)).resolves.toEqual(grant)
  const other = new GrantVault(issuer, 'other-fixture-installation')
  await expect(other.open(envelope)).rejects.toThrow('secure credential store unavailable')
  expect(keyring.size).toBe(1)

  const [address] = keyring.keys()
  keyring.set(address!, [])
  await expect(reopened.open(envelope)).rejects.toThrow('secure credential store unavailable')
})
