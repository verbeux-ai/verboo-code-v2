/** Authenticated encryption for grants; the encryption key lives exclusively in the OS credential store. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import { z } from 'zod'

const envelope = z.object({
  version: z.literal(1),
  issuer: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
})

/** Credential-store operations required by the encrypted grant owner. */
export interface SecretKeyStore {
  getSecret(): Promise<number[] | null>
  setSecret(secret: Uint8Array): Promise<void>
}

/** One installation and issuer's encrypted OAuth grant storage. */
export class GrantVault {
  private entry: Promise<SecretKeyStore> | undefined

  /**
   * @param issuer - exact OAuth issuer bound into authenticated encryption.
   * @param home - application home, isolating independent installations.
   * @param store - optional injected credential store for external-service fixtures.
   */
  constructor(
    private readonly issuer: string,
    private readonly home: string,
    store?: SecretKeyStore,
  ) {
    if (store !== undefined) this.entry = Promise.resolve(store)
  }

  private store(): Promise<SecretKeyStore> {
    return (this.entry ??= import('@napi-rs/keyring').then(
      ({ AsyncEntry }) =>
        new AsyncEntry(
          'Verboo Code Desktop',
          createHash('sha256')
            .update(`${this.issuer}\n${this.home}`)
            .digest('hex'),
          { linux: { store: 'secret-service' } },
        ),
    ))
  }

  private async key(create: boolean): Promise<Buffer> {
    const store = await this.store()
    let value = await store.getSecret()
    if (value === null && create) {
      const key = randomBytes(32)
      await store.setSecret(key)
      value = await store.getSecret()
    }
    if (value === null || value.length !== 32)
      throw new Error('Verboo Code: secure credential store unavailable')
    return Buffer.from(value)
  }

  /** Create the OS key while the caller holds the installation-record mutation lock. */
  async prepare(): Promise<void> {
    const key = await this.key(true)
    key.fill(0)
  }

  /**
   * Encrypt a grant while the caller holds the credential-record mutation lock.
   * @param value - private JSON grant; it never crosses account RPC.
   * @returns versioned ciphertext safe for the local credential record.
   */
  async seal(value: unknown): Promise<z.infer<typeof envelope>> {
    const key = await this.key(false)
    const nonce = randomBytes(12)
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(Buffer.from(this.issuer))
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
      ])
      return {
        version: 1,
        issuer: this.issuer,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }
    } finally {
      key.fill(0)
    }
  }

  /**
   * Decrypt only grants authenticated for this issuer and installation.
   * @param payload - persisted encrypted record.
   * @returns private JSON for the owning account provider to validate.
   */
  async open(payload: unknown): Promise<unknown> {
    const parsed = envelope.parse(payload)
    if (parsed.issuer !== this.issuer)
      throw new Error('Verboo Code: credential issuer mismatch')
    const key = await this.key(false)
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(parsed.nonce, 'base64'),
      )
      decipher.setAAD(Buffer.from(this.issuer))
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'))
      const plain = Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
        decipher.final(),
      ])
      return JSON.parse(plain.toString('utf8'))
    } finally {
      key.fill(0)
    }
  }

  /**
   * Check persisted grant metadata without touching the OS credential store.
   * @param payload - untrusted stored JSON.
   * @returns whether it is an encrypted grant belonging to this issuer.
   */
  owns(payload: unknown): boolean {
    const parsed = envelope.safeParse(payload)
    return parsed.success && parsed.data.issuer === this.issuer
  }
}
