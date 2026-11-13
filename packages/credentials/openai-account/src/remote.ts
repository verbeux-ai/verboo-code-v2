/**
 * The account's Remote surface: the two calls a sign-in dialog needs, and the
 * status it reads.
 *
 * The browser hop is the one part the Client cannot perform, so the Host builds
 * the authorization URL and accepts the code the provider redirects with. The
 * dialog opens the URL through the product's external link service, which
 * already decides between the system browser and a granted popup.
 *
 * @module @deepseek-ai/dsh-openai-account/remote
 */

import { Remote } from '@deepseek-ai/dsh-typert-protocol'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { OpenAiAccountStatus, SignInStart } from './types.ts'
import { OpenAiAccount } from './account.ts'

/**
 * One in-flight sign-in: the PKCE verifier and the redirect the request used.
 *
 * The handle is what the dialog returns, so the completion call cannot be
 * answered with a verifier the Host never issued.
 */
interface PendingSignIn {
  readonly verifier: string
  readonly redirectUri: string
  /** State the authorization request carried, which the callback must echo. */
  readonly state: string
  /** Epoch milliseconds after which the attempt is abandoned. */
  readonly expiresAt: number
  /** Settles when the browser reaches the callback, or when the attempt expires. */
  readonly settled: Promise<SignInStart & { readonly code: string } | undefined>
  /** Resolves the attempt with the code the callback received. */
  readonly accept: (code: string) => void
}

/** Path the provider redirects to; the Host's own webserver answers it. */
const CALLBACK_PATH = '/auth/callback'

/**
 * The sign-in surface the account dialog addresses.
 *
 * It never reports a token: the dialog learns whether a session exists, not what
 * it contains.
 */
export class OpenAiAccountLogin extends TypertRemoteService {
  static inject = ['openaiAccount', 'webServer']
  private readonly pending = new Map<string, PendingSignIn>()
  /** Deadline one abandoned attempt keeps its verifier, in milliseconds. */
  private readonly attemptTimeoutMs = 300_000

  /**
   * @param ctx - owning Cordis context, which already holds the account service.
   */
  constructor(ctx: Context) {
    super(ctx, 'openaiAccountLogin')
    // One callback route serves every attempt: the state decides which one a
    // response belongs to, so the path stays fixed.
    ctx.effect(() => {
      const server = ctx.get('webServer')
      if (server === undefined) return () => undefined
      return server.register({ kind: 'exact', path: CALLBACK_PATH, handler: (req: IncomingMessage, res: ServerResponse) => {
        this.answerCallback(new URL(req.url ?? '/', 'http://127.0.0.1'), res)
      } })
    }, 'OpenAI account: sign-in callback')
  }

  /** Reply to one browser callback, then let the waiting attempt finish. */
  private answerCallback(url: URL, res: ServerResponse): void {
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code')
    const denied = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    const accepted = code !== null && this.acceptCallback(state, code)
    res.writeHead(accepted ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
    res.end(accepted
      ? '<!doctype html><meta charset="utf-8"><title>Signed in</title><body style="font-family:system-ui;padding:48px"><h2>Signed in</h2><p>You can close this tab and return to Verboo Code.</p></body>'
      : `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><body style="font-family:system-ui;padding:48px"><h2>Sign-in failed</h2><p>${denied === null ? 'This response did not belong to a sign-in this app started.' : denied}</p></body>`)
  }

  /**
   * The account service this surface drives.
   *
   * Read through `ctx.get` on every call rather than captured once, so a
   * reloaded account plugin is the one that answers.
   */
  private get account(): OpenAiAccount {
    const service = this.ctx.get('openaiAccount')
    // The surface is mounted beside the account it drives; a missing service
    // means the composition is wrong, which must fail rather than go quiet.
    if (service === undefined) throw new Error('[OI] account: the account service is not mounted')
    return service
  }

  /**
   * Build the authorization URL for one sign-in attempt.
   * @param redirectUri - loopback callback the browser returns to.
   * @param signal - caller's cancellation signal.
   * @returns the URL to open and the handle the completion call presents.
   */
  @Remote('beginLogin')
  beginLogin(redirectUri: string, signal: AbortSignal): SignInStart {
    // Abandoned attempts would otherwise hold their verifier for the life of the
    // process; pruning here keeps the map bounded by attempts in progress.
    const now = Date.now()
    for (const [handle, attempt] of this.pending) {
      if (attempt.expiresAt <= now) this.pending.delete(handle)
    }
    const handle = randomHandle()
    const started = this.account.begin(redirectUri, signal)
    let accept: (code: string) => void = () => undefined
    const settled = new Promise<SignInStart & { readonly code: string } | undefined>((resolve) => {
      accept = (code) => { resolve({ url: started.url, handle, code }) }
    })
    this.pending.set(handle, {
      verifier: started.verifier,
      redirectUri,
      state: started.state,
      expiresAt: now + this.attemptTimeoutMs,
      settled,
      accept,
    })
    return { url: started.url, handle }
  }

  /**
   * Accept one code the browser delivered to the callback.
   *
   * The state is what proves the response belongs to an attempt this Host
   * started: a code arriving with any other value is refused rather than
   * exchanged.
   * @param state - state echoed by the provider.
   * @param code - authorization code the callback carried.
   * @returns true when an in-flight attempt accepted the code.
   */
  acceptCallback(state: string, code: string): boolean {
    for (const attempt of this.pending.values()) {
      if (attempt.expiresAt <= Date.now()) continue
      if (!OpenAiAccount.stateMatches(attempt.state, state)) continue
      attempt.accept(code)
      return true
    }
    return false
  }

  /**
   * Wait for the browser to reach the callback, then exchange its code.
   *
   * The listener is the Host's own webserver, so the reader never copies a code
   * between windows: the page the provider redirects to answers here.
   * @param handle - handle returned by {@link beginLogin}.
   * @param signal - caller's cancellation signal.
   * @returns the status of the session the exchange stored.
   * @throws when the handle is unknown, the attempt expires, or the exchange fails.
   */
  @Remote('awaitLogin')
  async awaitLogin(handle: string, signal: AbortSignal): Promise<OpenAiAccountStatus> {
    const pending = this.pending.get(handle)
    if (pending === undefined || pending.expiresAt <= Date.now())
      throw new Error('[OI] account: unknown or expired sign-in attempt')
    const delivered = await pending.settled
    if (delivered === undefined) throw new Error('[OI] account: the sign-in attempt expired')
    this.pending.delete(handle)
    return this.account.complete(delivered.code, pending.verifier, pending.redirectUri, signal)
  }

  /**
   * Exchange the code the provider redirected with.
   * @param handle - handle returned by {@link beginLogin}.
   * @param code - authorization code from the callback.
   * @param signal - caller's cancellation signal.
   * @returns the status of the session the exchange stored.
   * @throws when the handle is unknown or the exchange fails.
   */
  @Remote('completeLogin')
  async completeLogin(handle: string, code: string, signal: AbortSignal): Promise<OpenAiAccountStatus> {
    const pending = this.pending.get(handle)
    // A handle this service did not issue cannot carry a verifier it never
    // created, so an unknown one is refused rather than retried.
    if (pending === undefined || pending.expiresAt <= Date.now())
      throw new Error('[OI] account: unknown or expired sign-in attempt')
    this.pending.delete(handle)
    return this.account.complete(code, pending.verifier, pending.redirectUri, signal)
  }

  /**
   * Report the stored session's plan facts.
   * @returns the status; presence means a grant is stored, not that it is accepted.
   */
  @Remote('status')
  async status(): Promise<OpenAiAccountStatus> {
    return this.account.status()
  }

  /** Remove the stored session. */
  @Remote('signOut')
  async signOut(): Promise<void> {
    await this.account.signOut()
  }
}

/**
 * Build an opaque handle for one sign-in attempt.
 * @returns a random identifier that carries no account fact.
 */
function randomHandle(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url')
}

export default OpenAiAccountLogin
