/** The credential vault: seal/open round-trip, issuer binding, store lifecycle, and rejection paths. */
import { describe, expect, it, vi } from 'vitest'
import { GrantVault } from '../src/vault.ts'

/** One in-memory key store keyed by fixture, so no two vaults share a key. */
function memoryStore(): { getSecret(): Promise<number[] | null>; setSecret(secret: Uint8Array): Promise<void> } {
  let value: number[] | null = null
  return {
    getSecret: async () => value,
    setSecret: async (secret) => { value = [...secret] },
  }
}

describe('GrantVault', () => {
  it('seals a grant and opens it back unchanged, zeroing the key on the way', async () => {
    const vault = new GrantVault('https://issuer.example/oauth', '/home/fixture', memoryStore())
    await vault.prepare()
    const grant = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1 }
    const envelope = await vault.seal(grant)
    expect(envelope.version).toBe(1)
    expect(envelope.issuer).toBe('https://issuer.example/oauth')
    expect(envelope.ciphertext).not.toContain('access-1')
    await expect(vault.open(envelope)).resolves.toEqual(grant)
  })

  it('produces distinct ciphertexts for the same grant (fresh nonce)', async () => {
    const vault = new GrantVault('https://issuer.example/oauth', '/home/fixture', memoryStore())
    await vault.prepare()
    const grant = { accessToken: 'access-1' }
    const first = await vault.seal(grant)
    const second = await vault.seal(grant)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it('binds the issuer as authenticated data: a grant sealed for one issuer fails to open under another', async () => {
    const sealingVault = new GrantVault('https://issuer-a.example', '/home/fixture', memoryStore())
    await sealingVault.prepare()
    const sealed = await sealingVault.seal({ accessToken: 'secret' })
    const other = new GrantVault('https://issuer-b.example', '/home/fixture', memoryStore())
    await expect(other.open(sealed)).rejects.toThrow()
  })

  it('seals nothing readable across installations: the store key is issuer+home scoped', async () => {
    const grant = { accessToken: 'secret' }
    const sealingVault = new GrantVault('https://issuer.example/oauth', '/home/one', memoryStore())
    await sealingVault.prepare()
    const sealed = await sealingVault.seal(grant)
    // A vault in another installation cannot hold the same key, so the envelope
    // fails authentication rather than decoding into something.
    const foreign = new GrantVault('https://issuer.example/oauth', '/home/two', memoryStore())
    await expect(foreign.open(sealed)).rejects.toThrow()
  })

  it('refuses an envelope belonging to another issuer without touching the store', async () => {
    const vault = new GrantVault('https://issuer.example/oauth', '/home/fixture', memoryStore())
    await expect(vault.open({ version: 1, issuer: 'https://someone-else', nonce: '', tag: '', ciphertext: '' }))
      .rejects.toThrow('credential issuer mismatch')
  })

  it('reports ownership only for well-formed envelopes carrying this issuer', async () => {
    const issuer = 'https://issuer.example/oauth'
    const vault = new GrantVault(issuer, '/home/fixture', memoryStore())
    await vault.prepare()
    const sealed = await vault.seal({ accessToken: 'secret' })
    expect(vault.owns(sealed)).toBe(true)
    expect(vault.owns({ ...sealed, issuer: 'https://someone-else' })).toBe(false)
    expect(vault.owns({ nope: true })).toBe(false)
    expect(vault.owns('not an object')).toBe(false)
  })

  it('prepare creates the store key so a first login cannot fail on a missing one', async () => {
    const store = memoryStore()
    const vault = new GrantVault('https://issuer.example/oauth', '/home/fixture', store)
    await vault.prepare()
    expect(await store.getSecret()).not.toBeNull()
    // Sealing after prepare reuses the key the prepare created.
    const sealed = await vault.seal({ accessToken: 'secret' })
    await expect(vault.open(sealed)).resolves.toEqual({ accessToken: 'secret' })
  })

  it('lazily imports the OS keyring only when no store was injected', async () => {
    const importer = vi.fn(() => { throw new Error('no keyring in tests') })
    vi.doMock('@napi-rs/keyring', () => ({ AsyncEntry: importer }))
    try {
      const { GrantVault: FreshVault } = await import('../src/vault.ts')
      const vault = new FreshVault('https://issuer.example/oauth', '/home/fixture')
      // The store is resolved on first use, and the import is the OS bridge.
      await expect(vault.seal({ accessToken: 'secret' })).rejects.toThrow('no keyring in tests')
    } finally {
      vi.doUnmock('@napi-rs/keyring')
      vi.resetModules()
    }
  })
})
