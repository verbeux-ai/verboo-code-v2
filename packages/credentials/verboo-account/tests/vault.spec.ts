/** The Verboo credential vault: issuer binding, key lifecycle, and rejection paths. */
import { describe, expect, it } from 'vitest'
import { GrantVault, type SecretKeyStore } from '../src/vault.ts'

/** One in-memory key store, so no two vaults share a key. */
function memoryStore(): SecretKeyStore {
  let value: number[] | null = null
  return {
    getSecret: async () => value,
    setSecret: async (secret) => { value = [...secret] },
  }
}

describe('GrantVault', () => {
  it('seals a grant and opens it back unchanged', async () => {
    const vault = new GrantVault('https://auth.verboo.example', '/home/fixture', memoryStore())
    await vault.prepare()
    const grant = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1 }
    const envelope = await vault.seal(grant)
    expect(envelope.version).toBe(1)
    expect(envelope.issuer).toBe('https://auth.verboo.example')
    expect(envelope.ciphertext).not.toContain('access-1')
    await expect(vault.open(envelope)).resolves.toEqual(grant)
  })

  it('binds the issuer as authenticated data: another issuer cannot open the grant', async () => {
    const sealingVault = new GrantVault('https://issuer-a.example', '/home/fixture', memoryStore())
    await sealingVault.prepare()
    const sealed = await sealingVault.seal({ accessToken: 'secret' })
    const other = new GrantVault('https://issuer-b.example', '/home/fixture', memoryStore())
    await expect(other.open(sealed)).rejects.toThrow()
  })

  it('scopes the key by issuer and home: another installation cannot open it', async () => {
    const sealingVault = new GrantVault('https://auth.verboo.example', '/home/one', memoryStore())
    await sealingVault.prepare()
    const sealed = await sealingVault.seal({ accessToken: 'secret' })
    const foreign = new GrantVault('https://auth.verboo.example', '/home/two', memoryStore())
    await expect(foreign.open(sealed)).rejects.toThrow()
  })

  it('refuses an envelope carrying a different issuer before touching the key', async () => {
    const vault = new GrantVault('https://auth.verboo.example', '/home/fixture', memoryStore())
    await expect(vault.open({ version: 1, issuer: 'https://someone-else', nonce: '', tag: '', ciphertext: '' }))
      .rejects.toThrow('credential issuer mismatch')
  })

  it('reports ownership only for well-formed envelopes carrying this issuer', async () => {
    const issuer = 'https://auth.verboo.example'
    const vault = new GrantVault(issuer, '/home/fixture', memoryStore())
    await vault.prepare()
    const sealed = await vault.seal({ accessToken: 'secret' })
    expect(vault.owns(sealed)).toBe(true)
    expect(vault.owns({ ...sealed, issuer: 'https://someone-else' })).toBe(false)
    expect(vault.owns({ nope: true })).toBe(false)
    expect(vault.owns('not an object')).toBe(false)
  })

  it('refuses a stored key whose length is not the required 32 bytes', async () => {
    const wrongLength: SecretKeyStore = {
      getSecret: async () => [1, 2, 3],
      setSecret: async () => undefined,
    }
    const vault = new GrantVault('https://auth.verboo.example', '/home/fixture', wrongLength)
    await expect(vault.seal({ accessToken: 'secret' })).rejects.toThrow('secure credential store unavailable')
  })

  it('lazily imports the OS keyring when no store was injected', async () => {
    // The lazy import runs on first use: without an injected store the vault
    // reaches the OS keyring, which does not exist in tests.
    const vault = new GrantVault('https://auth.verboo.example', '/home/fixture')
    await expect(vault.seal({ accessToken: 'secret' })).rejects.toThrow()
  })
})
