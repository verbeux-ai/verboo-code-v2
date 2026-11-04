/** Reserve browser navigation during the user's gesture; async URLs never rely on popup exemptions. */
export class ExternalNavigationError extends Error {
  /**
   * Fixed category for a popup rejected by the browser.
   */
  readonly code = 'browser_blocked' as const
  constructor() {
    super('browser_navigation_blocked')
  }
}
/** A reserved external browser tab; it never receives an opener capability. */
export interface NavigationWindow {
  readonly closed: boolean
  opener: Window | null
  close(this: void): void
  location: { replace(this: void, url: string): void }
}
/** Owns browser reservations and validates native or Web handoffs. */
export class ExternalNavigation {
  private pending: NavigationWindow | null = null
  constructor(
    private readonly native: () =>
      | { openExternal(url: string): Promise<void> }
      | undefined,
    private readonly browserOpen: () => NavigationWindow | null,
  ) {}
  /**
   * Reserve a tab synchronously during a browser user gesture.
   */
  reserve(): void {
    if (this.native()) return
    this.release()
    const popup = this.browserOpen()
    if (popup === null) throw new ExternalNavigationError()
    popup.opener = null
    this.pending = popup
  }
  /**
   * Close an unused reservation without closing a handed-off tab.
   */
  release(): void {
    if (this.pending !== null) {
      this.pending.close()
      this.pending = null
    }
  }
  /**
   * Open an HTTPS or explicit loopback URL without a browser opener.
   * @param value - trusted handoff URL returned by the Host.
   * @returns after the system browser or reserved tab accepts navigation.
   */
  async open(value: string): Promise<void> {
    const url = new URL(value)
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error('external_url_invalid')
    const native = this.native()
    if (native) {
      await native.openExternal(url.href)
      return
    }
    const popup = this.pending ?? this.browserOpen()
    this.pending = null
    if (popup === null || popup.closed) throw new ExternalNavigationError()
    popup.opener = null
    popup.location.replace(url.href)
  }
}
