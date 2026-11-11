/**
 * Sign-in handoff ownership for one UI-initiated authorization attempt.
 *
 * The Host authorization URL only arrives after the start request, so the
 * browsing context must be reserved inside the user's click. The reservation
 * and the destination itself belong to the product link service: in a browser
 * it holds a popup, and in the installed application it hands the URL to the
 * system browser. This module only follows one attempt and retires the
 * reservation when the attempt ends.
 */
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ExternalLinksService } from '@deepseek-ai/dsh-client-external-links/client'

/** Follows one authorization attempt over the product link service. */
export class BrowserLogin {
  private navigated = false
  private attempt: SignInAttemptId | undefined

  /**
   * @param links - reads the current link service; absent until the service
   * plugin activates, and after its disposal.
   * @param destination - maps the Host authorization URL to the page the
   * destination opens, read when the attempt publishes its URL.
   */
  constructor(
    private readonly links: () => ExternalLinksService | undefined,
    private readonly destination: (authorizeUrl: string) => string,
  ) {}

  /**
   * Reserve the destination and bind it to the attempt returned by the Host.
   * @param request - authenticated Host start request.
   * @param latest - most recent streamed state, including frames received before the response.
   * @returns after this UI is following the new attempt.
   */
  async start(request: () => Promise<AccountView>, latest: () => AccountView | undefined): Promise<void> {
    this.begin()
    try {
      this.follow(await request())
      this.update(latest())
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /** Reserve the destination during the user's click. */
  begin(): void {
    this.dispose()
    this.links()?.begin()
  }

  /**
   * Bind the reserved destination to its Host attempt.
   * @param view - initial RPC response identifying this UI's attempt.
   */
  follow(view: AccountView): void {
    this.attempt = view.attempt?.id
    this.update(view)
  }

  /**
   * Present or retire the destination when its attempt changes.
   * @param view - latest Host state.
   */
  update(view: AccountView | undefined): void {
    const links = this.links()
    const attempt = view?.attempt
    if (attempt?.id !== this.attempt) return
    if (attempt && ['failed', 'expired', 'cancelled'].includes(attempt.phase)) {
      this.dispose()
      return
    }
    if (attempt?.phase === 'succeeded') {
      // A reservation the Host finished without is spent; closing it leaves no
      // blank tab behind.
      links?.end()
      this.attempt = undefined
      return
    }
    if (!attempt?.authorizeUrl || this.navigated) return
    this.navigated = true
    // A refused destination leaves the account surface's own link route; the
    // service publishes no second notice for this handoff.
    void links?.open(this.destination(attempt.authorizeUrl), { notice: false })
  }

  /** Release the owned reservation and stop following its attempt. */
  dispose(): void {
    this.links()?.end()
    this.attempt = undefined
    this.navigated = false
  }
}
