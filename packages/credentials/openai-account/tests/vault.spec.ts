import { beforeEach, expect, it, vi } from 'vitest'
import { GrantVault } from '../src/vault.ts'

const secrets = vi.hoisted(() => new Map<string, number[]>())
const opened = vi.hoisted(() => vi.fn())

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    private readonly address: string

    constructor(service: string, account: string, options?: unknown) {
      this.address = JSON.stringify([service, account])
      opened(service, account, options)
    }

    async getSecret(): Promise<number[] | null> { return secrets.get(this.address) ?? null }
    async setSecret(value: Uint8Array): Promise<void> { secrets.set(this.address, [...value]) }
  },
}))

beforeEach(() => { secrets.clear(); opened.mockClear() })

const issuer = 'https://issuer.fixture.test'

it.each([
  ['linux', { linux: { store: 'secret-service' } }],
  ['darwin', undefined],
] as const)('uses the platform keyring backend on %s', async (platform, options) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  try {
    const vault = new GrantVault(issuer, 'fixture-home')
    await vault.prepare()
    const envelope = await vault.seal({ account: 'fixture-account' })
    await expect(vault.open(envelope)).resolves.toEqual({ account: 'fixture-account' })
    expect(opened).toHaveBeenCalledExactlyOnceWith('Verboo Code [OI] Account', expect.stringMatching(/^[a-f0-9]{64}$/), options)
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
})

it('reopens a grant only for the same installation and verifies its authenticated envelope', async () => {
  const first = new GrantVault(issuer, 'fixture-home')
  await first.prepare()
  const envelope = await first.seal({ account: 'fixture-account' })
  const reopened = new GrantVault(issuer, 'fixture-home')
  const otherIssuer = new GrantVault('https://other-issuer.fixture.test', 'fixture-home')
  const otherHome = new GrantVault(issuer, 'other-fixture-home')
  expect(reopened.owns(envelope)).toBe(true)
  expect(reopened.owns({ version: 1, issuer })).toBe(false)
  expect(otherIssuer.owns(envelope)).toBe(false)
  await expect(reopened.open(envelope)).resolves.toEqual({ account: 'fixture-account' })
  await expect(otherIssuer.open(envelope)).rejects.toThrow('credential issuer mismatch')
  await expect(otherHome.open(envelope)).rejects.toThrow('secure credential store unavailable')
  const changedTag = Buffer.from(envelope.tag, 'base64')
  changedTag[0] = changedTag[0]! ^ 1
  await expect(reopened.open({ ...envelope, tag: changedTag.toString('base64') })).rejects.toThrow()
})
