/**
 * The [OI] account: the browser login, the token rotation behind it, and the
 * plan facts the login already carries.
 *
 * The ID token is a JWT whose payload names the ChatGPT plan and the end of its
 * paid window, so a successful login reports the subscription without a second
 * request. The access token is renewed through the refresh grant, which rotates
 * the refresh token: the new grant is persisted before it is used, so a crash
 * between the exchange and the write cannot leave a spent token stored.
 *
 * No token, and no provider response body, ever reaches a log or an error
 * message. Every failure becomes a fixed code from `types.ts`.
 *
 * @module @deepseek-ai/dsh-openai-account/account
 */

import { randomBytes, createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { AccountHttp, AccountRequestError } from './http.ts'
import { Config, deploymentOf, type Deployment } from './config.ts'
import type { OpenAiAccountStatus } from './types.ts'
import { GrantVault } from './vault.ts'

/** Cordis service key the route and the Client both address. */
export const SERVICE_KEY = 'openaiAccount'

/** Authorization parameters that make the issued grant Codex-compatible. */
const EXTRA_AUTHORIZE_PARAMS: Readonly<Record<string, string>> = {
  id_token_add_organizations: 'true',
  codex_cli_simplified_flow: 'true',
  originator: 'codex_cli_rs',
}

/** Claims namespace the ChatGPT plan facts live under. */
const AUTH_CLAIMS = 'https://api.openai.com/auth'

/** One stored grant: the tokens and the plan facts read out of the ID token. */
interface StoredGrant {
  readonly accessToken: string
  readonly refreshToken: string
  /** Epoch milliseconds at which the access token stops being accepted. */
  readonly expiresAt: number
  readonly accountId?: string
  readonly planType?: string
  readonly activeUntil?: string
}

/** The plan facts an ID token names. */
interface IdTokenClaims {
  readonly accountId?: string
  readonly planType?: string
  readonly activeUntil?: string
  readonly expiresAt?: number
}

/** Read a string field from an unknown record without asserting a shape. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Narrow an unknown value to a record so fields can be read from it. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Read the plan facts out of an ID token.
 *
 * The payload is the middle segment of the JWT and is base64url encoded. A token
 * this build cannot decode reports no facts rather than failing the login: the
 * plan is display data, while the tokens are what the route needs.
 * @param idToken - the JWT the token endpoint returned.
 * @returns the plan facts the payload names, or an empty record when it cannot be read.
 */
export function claimsOf(idToken: string): IdTokenClaims {
  const segments = idToken.split('.')
  if (segments.length < 2 || segments[1] === undefined) return {}
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as unknown
  } catch {
    // A payload this build cannot decode carries no plan facts; the tokens are
    // still usable, so the login does not fail over display data.
    return {}
  }
  const root = asRecord(payload)
  if (root === undefined) return {}
  const auth = asRecord(root[AUTH_CLAIMS])
  const expiresAt = typeof root.exp === 'number' ? root.exp * 1000 : undefined
  const accountId = auth === undefined ? undefined : stringField(auth, 'chatgpt_account_id')
  const planType = auth === undefined ? undefined : stringField(auth, 'chatgpt_plan_type')
  const activeUntil = auth === undefined ? undefined : stringField(auth, 'chatgpt_subscription_active_until')
  return {
    ...accountId === undefined ? {} : { accountId },
    ...planType === undefined ? {} : { planType },
    ...activeUntil === undefined ? {} : { activeUntil },
    ...expiresAt === undefined ? {} : { expiresAt },
  }
}

/** The PKCE verifier and the challenge derived from it. */
interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

/**
 * Build one PKCE pair for an authorization request.
 * @returns the verifier to keep and the S256 challenge to send.
 */
export function pkcePair(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * The [OI] account service: login, token renewal, and the status the Client reads.
 *
 * A stored grant is the only claim this service makes about being signed in; it
 * never asserts that the provider currently accepts the token.
 */
export class OpenAiAccount extends Service<never> {
  static inject = ['credentials']
  static Config = Config
  private readonly deployment: Deployment
  private readonly http: AccountHttp
  private readonly vault: GrantVault
  private grant: StoredGrant | undefined
  private reading: Promise<StoredGrant | undefined> | undefined
  private readonly grantFile: string
  /** Whether the OS credential store is expected to answer. */
  private readonly vaultUsable: boolean

  /**
   * @param ctx - owning Cordis context.
   * @param config - deployment configuration.
   * @param vault - optional credential-store fixture.
   */
  constructor(ctx: Context, config: Config = {}, vault?: GrantVault) {
    super(ctx, SERVICE_KEY)
    this.deployment = deploymentOf(config)
    this.http = new AccountHttp(this.deployment.requestTimeoutMs)
    const home = launchEnvironmentOf(ctx).get('DSH_HOME')?.value ?? join(process.cwd(), '.verboo-code')
    this.grantFile = join(home, 'openai-account.grant.json')
    this.vault = vault ?? new GrantVault(this.deployment.tokenUrl, home)
    // A Host without the OS credential store is a supported deployment: the
    // route stays signed out rather than failing the whole boot.
    this.vaultUsable = vault !== undefined || process.env.DSH_DISABLE_OS_KEYRING !== '1'
  }

  /** Persist one grant as a sealed envelope readable only by this issuer. */
  private async writeGrant(grant: StoredGrant): Promise<void> {
    let sealed
    try {
      // The vault creates its key only here; sealing reads an existing key, so a
      // fresh installation would fail every first login without this.
      await this.vault.prepare()
      sealed = await this.vault.seal(grant)
    } catch (cause) {
      throw new AccountRequestError('credential_store_unavailable', { cause })
    }
    // The key lives in the OS credential store, so the file holds ciphertext
    // only; the mode keeps another local account from reading even that.
    await writeFile(this.grantFile, `${JSON.stringify(sealed)}\n`, { mode: 0o600 })
  }

  /** Read the stored envelope, treating an absent or unreadable record as no session. */
  private async readGrant(): Promise<StoredGrant | undefined> {
    let raw: string
    try {
      raw = await readFile(this.grantFile, 'utf8')
    } catch {
      // No stored session is the ordinary first-run state, not a failure.
      return undefined
    }
    try {
      return await this.vault.open(JSON.parse(raw)) as StoredGrant
    } catch {
      // A record sealed by another installation cannot be opened here; the
      // account is treated as signed out rather than crashing the boot.
      return undefined
    }
  }

  /**
   * Start one browser login and return the URL the system browser opens.
   * @param redirectUri - loopback callback the Host serves.
   * @param signal - caller's cancellation signal.
   * @returns the authorization URL and the verifier the callback must present.
   */
  begin(redirectUri: string, signal: AbortSignal): { url: string; verifier: string } {
    const pkce = pkcePair()
    const url = new URL(this.deployment.authorizeUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.deployment.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', this.deployment.scopes.join(' '))
    url.searchParams.set('code_challenge', pkce.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', randomBytes(16).toString('base64url'))
    for (const [key, value] of Object.entries(EXTRA_AUTHORIZE_PARAMS)) url.searchParams.set(key, value)
    void signal
    return { url: url.href, verifier: pkce.verifier }
  }

  /**
   * Exchange one authorization code for a grant and persist it.
   * @param code - authorization code the callback received.
   * @param verifier - PKCE verifier kept from {@link begin}.
   * @param redirectUri - the exact redirect the authorization request used.
   * @param signal - caller's cancellation signal.
   * @returns the status the new grant reports.
   * @throws AccountRequestError when the exchange fails.
   */
  async complete(code: string, verifier: string, redirectUri: string, signal: AbortSignal): Promise<OpenAiAccountStatus> {
    const response = await this.http.json(this.deployment.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.deployment.clientId,
        code_verifier: verifier,
      }),
    }, { signal })
    this.grant = await this.persist(response.status, response.body, signal)
    return this.statusOf()
  }

  /**
   * Report the stored session's plan facts.
   * @returns the status; presence means a grant is stored, not that it is still accepted.
   */
  async status(): Promise<OpenAiAccountStatus> {
    if (!this.vaultUsable) return { signedIn: false }
    const grant = await this.stored()
    return this.statusOf(grant)
  }

  /**
   * Produce a token the route may send, renewing an expired one.
   * @param signal - caller's cancellation signal.
   * @returns a usable access token, or `undefined` when no session is stored.
   */
  async accessToken(signal: AbortSignal): Promise<string | undefined> {
    if (!this.vaultUsable) return undefined
    const grant = await this.stored()
    if (grant === undefined) return undefined
    if (grant.expiresAt - this.deployment.refreshLeewayMs > Date.now()) return grant.accessToken
    return (await this.renew(grant, signal))?.accessToken
  }

  /** Remove the stored grant and tell the tree no session remains. */
  async signOut(): Promise<void> {
    this.grant = undefined
    this.reading = undefined
    await rm(this.grantFile, { force: true })
    this.ctx.emit('openai-account/signed-out')
  }

  /** Read the grant once per process, from the vault. */
  private async stored(): Promise<StoredGrant | undefined> {
    if (this.grant !== undefined) return this.grant
    this.reading ??= this.readGrant()
    this.grant = await this.reading
    return this.grant
  }

  /** The status one grant reports; absent fields stay absent rather than defaulted. */
  private statusOf(stored?: StoredGrant): OpenAiAccountStatus {
    const grant = stored ?? this.grant
    if (grant === undefined) return { signedIn: false }
    return {
      signedIn: true,
      ...grant.planType === undefined ? {} : { planType: grant.planType },
      ...grant.accountId === undefined ? {} : { accountId: grant.accountId },
      ...grant.activeUntil === undefined ? {} : { activeUntil: grant.activeUntil },
    }
  }

  /** Validate one token response and persist it before it is used. */
  private async persist(status: number, body: unknown, signal: AbortSignal): Promise<StoredGrant> {
    if (status === 400 || status === 401) throw new AccountRequestError('session_expired')
    if (status >= 400) throw new AccountRequestError('invalid_response')
    const record = asRecord(body)
    if (record === undefined) throw new AccountRequestError('invalid_response')
    const accessToken = stringField(record, 'access_token')
    const refreshToken = stringField(record, 'refresh_token')
    const idToken = stringField(record, 'id_token')
    if (accessToken === undefined || refreshToken === undefined || idToken === undefined)
      throw new AccountRequestError('invalid_response')
    const claims = claimsOf(idToken)
    const grant: StoredGrant = {
      accessToken,
      refreshToken,
      expiresAt: claims.expiresAt ?? Date.now() + 3_600_000,
      ...claims.accountId === undefined ? {} : { accountId: claims.accountId },
      ...claims.planType === undefined ? {} : { planType: claims.planType },
      ...claims.activeUntil === undefined ? {} : { activeUntil: claims.activeUntil },
    }
    await this.writeGrant(grant)
    void signal
    return grant
  }

  /**
   * Renew one grant through the refresh token.
   *
   * A rejected refresh clears the stored session, because the stored grant can
   * no longer produce a token; the tree is told once so the Client can ask for a
   * new sign-in instead of retrying a dead grant.
   */
  private async renew(grant: StoredGrant, signal: AbortSignal): Promise<StoredGrant | undefined> {
    let response
    try {
      response = await this.http.json(this.deployment.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: grant.refreshToken,
          client_id: this.deployment.clientId,
        }),
      }, { signal })
    } catch (error) {
      if (error instanceof AccountRequestError && error.code === 'request_cancelled') throw error
      return undefined
    }
    if (response.status === 400 || response.status === 401) {
      await this.signOut()
      this.ctx.emit('openai-account/sign-in-required')
      return undefined
    }
    try {
      // Rotation: the exchange spent the presented refresh token, so the
      // replacement becomes the stored grant before it is used again.
      this.grant = await this.persist(response.status, response.body, signal)
      return this.grant
    } catch {
      return undefined
    }
  }
}

export default OpenAiAccount
