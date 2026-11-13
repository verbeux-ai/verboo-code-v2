/** Authenticated encryption for stored grants; the encryption key lives only in the OS credential store. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

/** Persisted ciphertext envelope; `issuer` binds the bytes to one OAuth issuer. */
export const envelope = z.object({
  version: z.literal(1),
  issuer: z.string(),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
})
/** One sealed envelope as persisted in a credential record. */
export type Envelope = z.infer<typeof envelope>

/** Credential-store operations the encrypted grant owner depends on. */
export interface SecretKeyStore {
  getSecret(): Promise<number[] | null>
  setSecret(secret: Uint8Array): Promise<void>
}

/** Credential-store service name this package owns; it never collides with another package's entry. */
const KEYRING_SERVICE = 'Verboo Code [OI] Account'
const KEY_BYTES = 32
const NONCE_BYTES = 12

/**
 * One installation and issuer's encrypted grant storage.
 *
 * The AES-256-GCM key never leaves the operating-system credential store, and
 * the issuer is bound as associated data, so a grant sealed for one issuer
 * cannot be opened by another.
 */
export class GrantVault {
  private entry: Promise<SecretKeyStore> | undefined

  /**
   * @param issuer - exact OAuth issuer bound into the authenticated encryption.
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
          KEYRING_SERVICE,
          createHash('sha256').update(`${this.issuer}\n${this.home}`).digest('hex'),
          { linux: { store: 'secret-service' } },
        ),
    ))
  }

  /**
   * Read the installation key, optionally creating it.
   * @param create - store a fresh random key when none exists yet.
   * @returns the key bytes; the caller owns and must wipe the buffer.
   * @throws Error when the OS credential store is unavailable or holds a wrong-length key.
   */
  private async key(create: boolean): Promise<Buffer> {
    const store = await this.store()
    let value = await store.getSecret()
    if (value === null && create) {
      await store.setSecret(randomBytes(KEY_BYTES))
      value = await store.getSecret()
    }
    if (value === null || value.length !== KEY_BYTES)
      throw new Error('[OI] account: secure credential store unavailable')
    return Buffer.from(value)
  }

  /** Create the OS key while the caller holds the installation-record mutation lock. */
  async prepare(): Promise<void> {
    const key = await this.key(true)
    key.fill(0)
  }

  /**
   * Encrypt a grant while the caller holds the credential-record mutation lock.
   * @param value - private JSON grant; it never crosses a public read.
   * @returns versioned ciphertext safe for the local credential record.
   */
  async seal(value: unknown): Promise<Envelope> {
    const key = await this.key(false)
    const nonce = randomBytes(NONCE_BYTES)
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(Buffer.from(this.issuer))
      const body = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
      ])
      return {
        version: 1,
        issuer: this.issuer,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: body.toString('base64'),
      }
    } finally {
      key.fill(0)
    }
  }

  /**
   * Decrypt only grants authenticated for this issuer and installation.
   * @param payload - persisted encrypted record.
   * @returns private JSON for the owning account service to validate.
   * @throws Error when the envelope is malformed, belongs to another issuer, or fails authentication.
   */
  async open(payload: unknown): Promise<unknown> {
    const sealed = envelope.parse(payload)
    if (sealed.issuer !== this.issuer)
      throw new Error('[OI] account: credential issuer mismatch')
    const key = await this.key(false)
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(sealed.nonce, 'base64'),
      )
      decipher.setAAD(Buffer.from(this.issuer))
      decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
      const plain = Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ])
      return JSON.parse(plain.toString('utf8'))
    } finally {
      key.fill(0)
    }
  }

  /**
   * Check persisted envelope metadata without touching the OS credential store.
   * @param payload - untrusted stored JSON.
   * @returns whether it is an encrypted grant belonging to this issuer.
   */
  owns(payload: unknown): boolean {
    const sealed = envelope.safeParse(payload)
    return sealed.success && sealed.data.issuer === this.issuer
  }
}
