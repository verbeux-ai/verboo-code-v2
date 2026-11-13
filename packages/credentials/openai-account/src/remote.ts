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
import type { Context } from '@deepseek-ai/cordis'
import type { OpenAiAccountStatus, SignInStart } from './types.ts'
import type { OpenAiAccount } from './account.ts'

/**
 * One in-flight sign-in: the PKCE verifier and the redirect the request used.
 *
 * The handle is what the dialog returns, so the completion call cannot be
 * answered with a verifier the Host never issued.
 */
interface PendingSignIn {
  readonly verifier: string
  readonly redirectUri: string
  /** Epoch milliseconds after which the attempt is abandoned. */
  readonly expiresAt: number
}

/**
 * The sign-in surface the account dialog addresses.
 *
 * It never reports a token: the dialog learns whether a session exists, not what
 * it contains.
 */
export class OpenAiAccountLogin extends TypertRemoteService {
  static inject = ['openaiAccount']
  private readonly pending = new Map<string, PendingSignIn>()
  /** Deadline one abandoned attempt keeps its verifier, in milliseconds. */
  private readonly attemptTimeoutMs = 300_000

  /**
   * @param ctx - owning Cordis context, which already holds the account service.
   */
  constructor(ctx: Context) {
    super(ctx, 'openaiAccountLogin')
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
    this.pending.set(handle, {
      verifier: started.verifier,
      redirectUri,
      expiresAt: now + this.attemptTimeoutMs,
    })
    return { url: started.url, handle }
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
