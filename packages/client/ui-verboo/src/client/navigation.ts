/**
 * Account handoff (sign-in, connections, billing) over the shared external link
 * service. The destination policy — allowlisted schemes, the Desktop native
 * handoff, the Sidebar Browser, and the refusal notice — belongs to
 * `ctx.externalLinks`; this adapter only reserves the browsing context during
 * the user's gesture and translates a refusal into the account surface's own
 * failure state.
 */
import type { ExternalLinksService } from '@deepseek-ai/dsh-client-external-links/client'

/** A handoff the product could not complete. */
export class ExternalNavigationError extends Error {
  /**
   * Fixed category the account surface shows.
   */
  readonly code = 'browser_blocked' as const
  /**
   * @param detail - why the handoff stopped, for the log only.
   */

}

/** Account handoff reservation and open, over the product link service. */
export class ExternalNavigation {
  /**
   * @param service - reads the current link service; absent until the service
   * plugin activates, and after its disposal.
   */
  constructor(private readonly service: () => ExternalLinksService | undefined) {}

  /**
   * Reserve the browsing context for a destination that arrives after an
   * asynchronous Host step. Desktop and the Sidebar Browser need none.
   * @returns nothing.
   */
  reserve(): void {
    this.service()?.begin()
  }

  /**
   * Close a reservation whose destination never arrived.
   * @returns nothing.
   */
  release(): void {
    this.service()?.end()
  }

  /**
   * Present a Host-issued destination.
   * @param url - destination issued for this handoff.
   * @returns after the destination accepts the URL.
   * @throws ExternalNavigationError when the destination refused it or the
   * service is unavailable; the account surface reports the failure itself.
   */
  async open(url: string): Promise<void> {
    const service = this.service()
    if (service === undefined) throw new ExternalNavigationError('external_links_unavailable')
    const destination = await service.open(url, { notice: false })
    if (destination === 'blocked') throw new ExternalNavigationError('browser_navigation_blocked')
  }
}
