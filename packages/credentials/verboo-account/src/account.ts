/** Verboo OAuth 2.1 account provider over the shared account and authorization services. */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  DeepSeekAccount,
  installAccountTaskCancellation,
} from '@deepseek-ai/dsh-deepseek-account'
import type {
  AccountBonusBatch,
  AccountBonusOrderId,
  AccountClientMetadata,
  AccountDetails,
  AccountUserId,
  AccountView,
  PlatformSession,
  SignInAttemptId,
  SignInAttemptView,
  SignInErrorCode,
} from '@deepseek-ai/dsh-deepseek-account'
import type {
  AccountSessionId,
  AccountCredentialRevision,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, deploymentOf } from './config.ts'
import type { Deployment } from './config.ts'
import { AccountRequestError, operation, VerbooHttp } from './http.ts'
import type { Operation } from './http.ts'
import { GrantVault } from './vault.ts'
import { LoginJourney } from './journey.ts'

const KEY = credentialKey('verboo-account', 'default')
const DEVICE = credentialKey('verboo-account', 'installation')
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
  expires_in: z.number().positive(),
})
const storedGrant = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  installationId: z.uuid(),
  sessionId: z.uuid(),
})
const meResponse = z.object({
  data: z.object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    avatarUrl: z.url().nullish(),
  }),
})
const deviceResponse = z.object({ id: z.uuid() })
type Grant = z.infer<typeof storedGrant>

interface Attempt {
  view: SignInAttemptView
  controller: AbortController
  running: Promise<void>
  done: Promise<void>
  redirectUri: string
  client: AccountClientMetadata
  context: Operation
  response?: ServerResponse
  removeRoute?: () => Promise<void>
}

/** Verboo's public PKCE client; encrypted grants remain exclusively on the Host. */
export class VerbooAccount extends DeepSeekAccount {
  static inject = ['credentials', 'authorization']
  static Config = Config
  private readonly deployment: Deployment
  private readonly http: VerbooHttp
  private readonly vault: GrantVault
  private readonly journey: LoginJourney
  private attempt: Attempt | undefined
  private removing: Promise<AccountView> | undefined
  private readonly listeners = new Set<(identityOnly: boolean) => void>()
  private lifetime = new AbortController()
  private readonly revocations = new Set<Promise<void>>()
  private profile: { sessionId: string; id: AccountUserId } | undefined
  private closed = false

  /**
 * @param ctx - owning credentials and authorization services.
 * @param config - deployment configuration.
 * @param vault - optional external credential-store fixture.
 */
  constructor(ctx: Context, config: Config = {}, vault?: GrantVault) {
    super(ctx)
    this.deployment = deploymentOf(config)
    this.http = new VerbooHttp(this.deployment)
    this.journey = new LoginJourney(ctx, this.deployment)
    const home =
      launchEnvironmentOf(ctx).get('DSH_HOME')?.value ??
      join(homedir(), '.verboo-code')
    this.vault = vault ?? new GrantVault(this.deployment.apiOrigin, home)
    installAccountTaskCancellation(ctx)
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Verboo Code',
      methods: [{ id: 'browser', label: 'Verboo Code' }],
      run: (session) => {
        const attempt = this.attempt
        if (attempt === undefined)
          return Promise.reject(new AccountRequestError('contract_error'))
        attempt.running = this.authorize(session, attempt)
        return attempt.running
      },
    })
    ctx.on('credentials/record-updated', (key) => {
      if (key !== KEY) return
      this.lifetime.abort()
      this.lifetime = new AbortController()
      this.changed()
    })
    ctx.effect(
      () => async () => {
        this.closed = true
        this.lifetime.abort()
        if (this.attempt !== undefined)
          await this.cancelSignIn(this.attempt.view.id)
        await this.removing
        await Promise.all(this.revocations)
        this.changed()
      },
      'Verboo account requests and authorization',
    )
  }

  override async getState(): Promise<AccountView> {
    const grant = await this.readGrant()
    return {
      ...(grant !== null
        ? {
          credentialRevision: brandString<AccountCredentialRevision>(
            createHash('sha256')
              .update(grant.sessionId)
              .digest('hex'),
          ),
        }
        : {}),
      status: grant !== null ? 'credential-stored' : 'signed-out',
      links: {
        usageUrl: `${this.deployment.apiOrigin}/pt/dashboard`,
        topUpUrl: `${this.deployment.apiOrigin}/pt/plans`,
      },
      attempt: this.attempt?.view ?? null,
    }
  }

  private async readGrant(record?: CredentialRecord): Promise<Grant | null> {
    const current = record ?? (await this.ctx.credentials.readRecord(KEY))
    if (current === undefined) return null
    if (current.kind !== 'grant')
      throw new AccountRequestError('contract_error')
    if (!this.vault.owns(current.payload)) return null
    return storedGrant.parse(await this.vault.open(current.payload))
  }

  private async installation(): Promise<string> {
    const record = await this.ctx.credentials.modifyRecord(
      DEVICE,
      async (current) => {
        // One cross-process record lock also serializes first creation of the OS key.
        await this.vault.prepare()
        if (current !== undefined) {
          if (current.kind !== 'grant')
            throw new AccountRequestError('contract_error')
          deviceResponse.parse(current.payload)
          return undefined
        }
        return { kind: 'grant', payload: { id: randomUUID() } }
      },
    )
    if (record?.kind !== 'grant')
      throw new AccountRequestError('contract_error')
    return deviceResponse.parse(record.payload).id
  }

  /**
   * Begin a PKCE authorization owned by the current installation.
   * @param client - locale and release metadata for the operation.
   * @param callbackOrigin - authenticated Client origin initiating the login.
   * @param _source - Client surface initiating the authorization.
   * @returns the current sign-in observation without tokens.
   */
  override async startSignIn(
    client: AccountClientMetadata,
    callbackOrigin: string,
    _source: 'web' | 'desktop',
  ): Promise<AccountView> {
    if (this.removing !== undefined) await this.removing
    if (this.closed) throw new AccountRequestError('request_cancelled')
    if (
      this.attempt &&
      ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(
        this.attempt.view.phase,
      )
    )
      return this.getState()
    if (this.attempt) await this.attempt.done
    const origin = new URL(callbackOrigin)
    if (
      origin.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      !origin.port
    ) {
      throw new AccountRequestError('contract_error')
    }
    const attempt: Attempt = {
      view: {
        id: brandString<SignInAttemptId>(randomUUID()),
        phase: 'initializing',
      },
      controller: new AbortController(),
      running: Promise.resolve(),
      done: Promise.resolve(),
      redirectUri: `${origin.origin}/callback`,
      client,
      context: operation(),
    }
    this.attempt = attempt
    this.journey.record(attempt.context, 'started')
    attempt.done = this.ctx.authorization
      .begin({
        key: KEY,
        signal: attempt.controller.signal,
        interaction: {
          notify: () => undefined,
          prompt: () =>
            Promise.reject(new AccountRequestError('contract_error')),
        },
      })
      .then((outcome) => {
        this.update(attempt, {
          phase: outcome.status === 'authorized' ? 'succeeded' : 'cancelled',
        })
        this.journey.record(
          attempt.context,
          outcome.status === 'authorized' ? 'succeeded' : 'failed',
          outcome.status === 'authorized'
            ? undefined
            : new AccountRequestError('request_cancelled'),
        )
        this.finishCallback(attempt, outcome.status === 'authorized')
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof AccountRequestError
            ? error
            : new AccountRequestError('contract_error')
        const errorCode: SignInErrorCode =
          failure.code === 'request_timeout'
            ? 'expired'
            : failure.code === 'network_error'
              ? 'network'
              : 'protocol'
        this.update(attempt, {
          phase: errorCode === 'expired' ? 'expired' : 'failed',
          errorCode,
        })
        this.journey.record(attempt.context, 'failed', failure)
        this.finishCallback(attempt, false)
      })
      .then(async () => {
        // The flow must release its callback and network work before another attempt starts.
        await attempt.running.catch((_error: unknown) => {
          /* Authorization already reported the sanitized outcome. */
        })
        await attempt.removeRoute?.()
      })
    this.changed()
    return this.getState()
  }

  private async authorize(
    session: AuthorizationSession,
    attempt: Attempt,
  ): Promise<void> {
    const server = this.ctx.get('webServer')
    if (server === undefined) throw new AccountRequestError('contract_error')
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const code = Promise.withResolvers<string>()
    void code.promise.catch((_error: unknown) => {
      /* The authorization await observes this rejection. */
    })
    const deadline = AbortSignal.timeout(this.deployment.attemptTimeoutMs)
    const signal = AbortSignal.any([session.signal, deadline])
    const abort = () => {
      code.reject(
        new AccountRequestError(
          deadline.aborted ? 'request_timeout' : 'request_cancelled',
        ),
      )
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const installationId = await this.installation()
      attempt.removeRoute = this.ctx.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/callback',
            handler: (req, res) => {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1')
              const incomingState = url.searchParams.get('state') ?? ''
              const validState =
                Buffer.byteLength(state) === Buffer.byteLength(incomingState) &&
                timingSafeEqual(Buffer.from(state), Buffer.from(incomingState))
              const receivedCode = url.searchParams.get('code')
              const denied = url.searchParams.get('error')
              if (
                req.method !== 'GET' ||
                url.searchParams.getAll('state').length !== 1 ||
                !validState ||
                (denied === null
                  ? url.searchParams.getAll('code').length !== 1 ||
                    !receivedCode ||
                    receivedCode.length > 4096
                  : url.searchParams.getAll('error').length !== 1 ||
                    url.searchParams.has('code'))
              ) {
                res.writeHead(400, { 'cache-control': 'no-store' }).end()
                return
              }
              if (
                signal.aborted ||
                attempt.response !== undefined ||
                attempt.view.phase !== 'waiting-browser'
              ) {
                res.writeHead(410, { 'cache-control': 'no-store' }).end()
                return
              }
              attempt.response = res
              if (denied === 'access_denied') {
                attempt.controller.abort()
                code.reject(new AccountRequestError('request_cancelled'))
              } else if (denied !== null)
                code.reject(new AccountRequestError('unknown'))
              else if (receivedCode) code.resolve(receivedCode)
              else code.reject(new AccountRequestError('contract_error'))
            },
          }),
        'Verboo OAuth callback',
      )
      signal.throwIfAborted()
      const url = new URL('/oauth/authorize', this.deployment.apiOrigin)
      for (const [key, value] of Object.entries({
        client_id: this.deployment.clientId,
        response_type: 'code',
        redirect_uri: attempt.redirectUri,
        scope: 'user:profile user:inference',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        installation_id: installationId,
      }))
        url.searchParams.set(key, value)
      this.update(attempt, {
        phase: 'waiting-browser',
        authorizeUrl: url.href,
        expiresAt: Date.now() + this.deployment.attemptTimeoutMs,
      })
      const receivedCode = await code.promise
      signal.throwIfAborted()
      this.update(attempt, { phase: 'exchanging' })
      const grant = await this.exchange(
        {
          grant_type: 'authorization_code',
          code: receivedCode,
          redirect_uri: attempt.redirectUri,
          code_verifier: verifier,
          installation_id: installationId,
        },
        signal,
        attempt.context,
      )
      signal.throwIfAborted()
      this.update(attempt, { phase: 'committing' })
      await session.commit({
        kind: 'grant',
        payload: await this.vault.seal({
          ...grant,
          installationId,
          sessionId: randomUUID(),
        }),
      })
    } catch (error) {
      if (deadline.aborted) throw new AccountRequestError('request_timeout')
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private async exchange(
    form: Record<string, string>,
    signal: AbortSignal,
    context: Operation,
  ): Promise<Omit<Grant, 'installationId' | 'sessionId'>> {
    const response = tokenResponse.safeParse(
      await this.http.request(
        `${this.deployment.apiOrigin}/oauth/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            ...form,
            client_id: this.deployment.clientId,
          }),
          signal,
        },
        context,
      ),
    )
    if (!response.success) throw new AccountRequestError('contract_error')
    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      expiresAt: Date.now() + response.data.expires_in * 1000,
    }
  }

  override async cancelSignIn(id: SignInAttemptId): Promise<AccountView> {
    const attempt = this.attempt
    if (attempt?.view.id === id) {
      if (attempt.view.phase !== 'committing') {
        attempt.controller.abort()
        this.ctx.authorization.cancel(KEY)
      }
      await attempt.done
    }
    return this.getState()
  }

  override async resolveToken(url: string): Promise<string | undefined> {
    const target = new URL(url)
    const router = new URL(this.deployment.routerBaseURL)
    const prefix = router.pathname.replace(/\/$/, '')
    if (
      target.origin !== router.origin ||
      target.username ||
      target.password ||
      !(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))
    )
      return undefined
    const current = await this.readGrant()
    if (current === null) return undefined
    if (current.expiresAt > Date.now() + 60_000) return current.accessToken
    return this.refreshRejectedToken(url, current.accessToken)
  }

  override async refreshRejectedToken(
    url: string,
    rejectedToken: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const target = new URL(url)
    const router = new URL(this.deployment.routerBaseURL)
    const prefix = router.pathname.replace(/\/$/, '')
    if (
      target.origin !== router.origin ||
      target.username ||
      target.password ||
      !(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))
    )
      return undefined
    const resultState = { rejected: false }
    const lifetime = this.lifetime
    const result = await this.ctx.credentials.modifyRecord(
      KEY,
      async (record) => {
        if (record === undefined) return undefined
        const stored = await this.readGrant(record)
        if (stored === null || stored.accessToken !== rejectedToken)
          return undefined
        try {
          const updated = await this.exchange(
            {
              grant_type: 'refresh_token',
              refresh_token: stored.refreshToken,
              installation_id: stored.installationId,
              scope: 'user:profile user:inference',
            },
            signal === undefined
              ? lifetime.signal
              : AbortSignal.any([lifetime.signal, signal]),
            operation(),
          )
          return {
            kind: 'grant',
            payload: await this.vault.seal({
              ...updated,
              installationId: stored.installationId,
              sessionId: stored.sessionId,
            }),
          }
        } catch (error) {
          if (
            !(error instanceof AccountRequestError) ||
            error.code !== 'authentication_invalid'
          )
            throw error
          resultState.rejected = true
          return this.signedOutRecord()
        }
      },
    )
    const current = result === undefined ? null : await this.readGrant(result)
    if (resultState.rejected) this.expired()
    if (current !== null && current.accessToken !== rejectedToken)
      return current.accessToken
    if (result === undefined) {
      const latest = await this.readGrant()
      if (latest !== null && latest.accessToken !== rejectedToken)
        return latest.accessToken
    }
    return undefined
  }

  private signedOutRecord(): CredentialRecord {
    return {
      kind: 'grant',
      payload: {
        version: 1,
        issuer: this.deployment.apiOrigin,
        status: 'signed-out',
      },
    }
  }

  override async rejectToken(token: string): Promise<void> {
    const resultState = { rejected: false }
    await this.ctx.credentials.modifyRecord(KEY, async (record) => {
      if (record === undefined) return undefined
      if ((await this.readGrant(record))?.accessToken !== token)
        return undefined
      resultState.rejected = true
      return this.signedOutRecord()
    })
    if (resultState.rejected) this.expired()
  }

  private expired(): void {
    this.ctx.emit('deepseek-account/session-expired')
    this.ctx.emit('deepseek-account/signed-out')
  }

  override signOut(_client: AccountClientMetadata): Promise<AccountView> {
    this.removing ??= (async () => {
      if (this.attempt) await this.cancelSignIn(this.attempt.view.id)
      const previous = await this.readGrant()
      const outcome: { changed: boolean; revoke: Grant | null } = { changed: false, revoke: null }
      await this.ctx.credentials.modifyRecord(KEY, async (record) => {
        const stored =
          record === undefined ? null : await this.readGrant(record)
        if (stored?.sessionId !== previous?.sessionId) return undefined
        outcome.changed = true
        outcome.revoke = stored
        return this.signedOutRecord()
      })
      if (!outcome.changed) return this.getState()
      this.lifetime.abort()
      this.attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      if (outcome.revoke !== null) {
        const revoked: Grant = outcome.revoke
        const task = this.http
          .request(
            `${this.deployment.apiOrigin}/oauth/revoke`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token: revoked.refreshToken,
                token_type_hint: 'refresh_token',
                client_id: this.deployment.clientId,
              }),
            },
            operation(),
            true,
          )
          .then(() => undefined)
          .catch((_error: unknown) => {
            console.error('[verboo-account] revocation_unconfirmed')
          })
          .finally(() => this.revocations.delete(task))
        this.revocations.add(task)
      }
      return this.getState()
    })().finally(() => {
      this.removing = undefined
    })
    return this.removing
  }

  private async detail(
    path: string,
  ): Promise<{ sessionId: string; response: unknown } | null> {
    const token = await this.resolveToken(this.deployment.routerBaseURL)
    if (token === undefined) return null
    const lifetime = this.lifetime
    const grant = await this.readGrant()
    if (grant?.accessToken !== token || lifetime !== this.lifetime) return null
    try {
      const response = await this.http.request(
        `${this.deployment.apiOrigin}${path}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: lifetime.signal,
        },
      )
      if (lifetime !== this.lifetime || lifetime.signal.aborted) return null
      return { sessionId: grant.sessionId, response }
    } catch (error) {
      if (lifetime !== this.lifetime || lifetime.signal.aborted) return null
      if (
        error instanceof AccountRequestError &&
        error.code === 'authentication_invalid'
      ) {
        await this.rejectToken(token)
        return null
      }
      throw error
    }
  }

  override async getProfile(
    _client: AccountClientMetadata,
  ): Promise<AccountDetails['profile'] | null> {
    try {
      const result = await this.detail('/api/me')
      if (result === null) return null
      const user = meResponse.parse(result.response).data
      const id = brandString<AccountUserId>(user.id)
      const changed = this.profile?.id !== id || this.profile.sessionId !== result.sessionId
      this.profile = { sessionId: result.sessionId, id }
      if (changed) this.changed(true)
      return {
        status: 'ready',
        value: {
          id,
          name: user.name,
          contact: user.email,
          avatarUrl: user.avatarUrl ?? null,
        },
      }
    } catch (_error: unknown) {
      return { status: 'failed' }
    }
  }

  override getBalance(
    _client: AccountClientMetadata,
  ): Promise<AccountDetails['balance'] | null> {
    return Promise.resolve(null)
  }

  override getUnnotifiedBonuses(
    _client: AccountClientMetadata,
  ): Promise<AccountBonusBatch | null> {
    return Promise.resolve(null)
  }
  override ackBonusNotified(
    _accountId: AccountUserId,
    _orderId: AccountBonusOrderId,
    _client: AccountClientMetadata,
  ): Promise<boolean> {
    return Promise.resolve(false)
  }
  override async getPlatformSession(): Promise<PlatformSession | null> {
    const grant = await this.readGrant()
    return grant === null
      ? null
      : {
        origin: this.deployment.apiOrigin,
        token: grant.accessToken,
        sessionId: brandString<AccountSessionId>(grant.sessionId),
        userId:
            this.profile?.sessionId === grant.sessionId ? this.profile.id : null,
      }
  }
  override async getDeviceIdentity(): Promise<{
    deviceId?: string
    userId?: AccountUserId
    osVersion: string
  }> {
    const record = await this.ctx.credentials.readRecord(DEVICE)
    const device =
      record?.kind === 'grant'
        ? deviceResponse.parse(record.payload)
        : undefined
    const userId = (await this.getPlatformSession())?.userId
    return {
      ...(device ? { deviceId: device.id } : {}),
      ...(userId ? { userId } : {}),
      osVersion: release(),
    }
  }

  override async *watch(
    signal: AbortSignal,
    includeIdentityChanges = false,
  ): AsyncIterable<AccountView> {
    let dirty = true
    let wake = Promise.withResolvers<void>()
    const hasChanges = (): boolean => dirty
    const changed = (identityOnly: boolean) => {
      if (!identityOnly || includeIdentityChanges) {
        dirty = true
        wake.resolve()
      }
    }
    const aborted = () => {
      wake.resolve()
    }
    this.listeners.add(changed)
    signal.addEventListener('abort', aborted, { once: true })
    try {
      while (!signal.aborted && !this.closed) {
        if (dirty) {
          dirty = false
          yield await this.getState()
        }
        if (hasChanges()) continue
        await wake.promise
        wake = Promise.withResolvers<void>()
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', aborted)
    }
  }

  private changed(identityOnly = false): void {
    for (const listener of this.listeners) listener(identityOnly)
  }
  private update(attempt: Attempt, patch: Partial<SignInAttemptView>): void {
    const { authorizeUrl: _url, ...current } = attempt.view
    attempt.view = { ...current, ...patch }
    this.changed()
  }
  private finishCallback(attempt: Attempt, success: boolean): void {
    if (attempt.response === undefined || attempt.response.destroyed) return
    const pt = attempt.client.locale.toLowerCase().startsWith('pt')
    const message = success
      ? pt
        ? 'Login concluído. Pode fechar esta janela e voltar ao Verboo Code.'
        : 'Signed in. You can close this window and return to Verboo Code.'
      : pt
        ? 'Não foi possível entrar. Volte ao Verboo Code para tentar novamente.'
        : 'Sign-in could not finish. Return to Verboo Code to try again.'
    attempt.response
      .writeHead(success ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      })
      .end(
        `<!doctype html><html lang="${pt ? 'pt-BR' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verboo Code</title><style>body{font:16px system-ui;background:#17131e;color:#f8f4ff;display:grid;place-content:center;min-height:90vh;margin:24px}h1{color:#ad34fe}p{max-width:38em;line-height:1.6}</style><h1>Verboo Code</h1><p>${message}</p></html>`,
      )
  }
}
