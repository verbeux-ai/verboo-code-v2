/**
 * The single external link service: one place decides whether a destination
 * opens in the Sidebar Browser, in a popup the browser granted, or in the
 * operating system's browser through the Desktop bridge.
 *
 * The service is the only caller of `window.open` and of the Desktop
 * `openExternal` bridge. Consumers pass an authored destination and get back
 * which destination accepted it. A refusal is published through the notice
 * channel so the UI can show it: a browser-rejected popup is otherwise
 * indistinguishable from a link that did nothing.
 */

/** Native handoff capability: the Desktop bridge's validated external opener. */
export interface ExternalLinkNative {
  /**
   * Open an absolute destination in the system browser.
   * @param url - validated absolute URL.
   * @returns a promise that settles after the native opener accepts it.
   */
  openExternal(url: string): Promise<void>
}

/** A browser popup reserved during a user gesture; it never receives an opener capability. */
export interface ExternalLinkWindow {
  readonly closed: boolean
  opener: Window | null
  close(this: void): void
  /** @param url - absolute destination. */
  location: { replace(this: void, url: string): void }
}

/** Where a destination was sent. */
export type ExternalLinkDestination =
  /** A right-Sidebar Browser tab. */
  | 'sidebar'
  /** A browser popup the browser granted. */
  | 'window'
  /** The Desktop native bridge. */
  | 'native'
  /** Refused; the notice channel explains why. */
  | 'blocked'

/** Per-opening inputs. */
export interface ExternalLinkOptions {
  /** Cancels the open before any destination is chosen. */
  readonly signal?: AbortSignal
  /**
   * Whether a refusal also publishes the shared notice. Set false when the
   * caller shows the refusal in its own surface, so one click never shows two
   * messages.
   */
  readonly notice?: boolean
}

/** Refusal categories the service distinguishes for its callers and its notice. */
export type ExternalLinkFailure =
  /** Not a destination this application opens. */
  | 'unsupported'
  /** The browser returned no popup for the gesture. */
  | 'blocked'
  /** The Desktop native opener rejected the handoff. */
  | 'nativeFailed'

/** Schemes this application hands to another program. */
const HANDOFF_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** Schemes the Sidebar Browser renders; anything else has no in-app page. */
const BROWSE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:'])

/**
 * The parsed destination this application may open, with credentials and
 * shape rejected rather than normalized.
 * @param value - authored or host-supplied destination.
 * @returns the parsed URL, or undefined for a relative, unparsable, credential-bearing, or unlisted destination.
 */
export function openableUrl(value: string): URL | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch (_error) {
    // A relative or malformed destination has no target outside this document.
    return undefined
  }
  if (url.username !== '' || url.password !== '') return undefined
  if (!HANDOFF_SCHEMES.has(url.protocol)) return undefined
  return url
}

/**
 * Hand a non-browsable scheme to the program registered for it without a
 * popup: an anchor activation keeps the current document and lets the browser
 * own the protocol handoff.
 * @param url - validated absolute destination.
 * @returns nothing.
 */
export function activateHandoff(url: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.rel = 'noopener noreferrer'
  anchor.click()
}

/** Inputs the service cannot discover on its own. */
export interface ExternalLinkDeps {
  /** Native handoff, when the Desktop bridge supplies one. */
  readonly native: ExternalLinkNative | undefined
  /** Browser popup for a URL; only called inside a user gesture. */
  readonly openWindow: (url: string) => ExternalLinkWindow | null
  /** Whether a Sidebar Browser tab type is registered right now. */
  readonly sidebar: () => boolean
  /**
   * Open a Sidebar Browser tab.
   * @param url - validated absolute destination.
   */
  readonly openSidebar: (url: string) => void
  /** Current destination preference for ordinary clicks. */
  readonly preference: () => 'sidebar' | 'new-tab'
  /** Publish a refusal the UI explains to the user. */
  readonly report: (failure: ExternalLinkFailure) => void
}

/**
 * Route every external destination through one policy.
 *
 * Desktop hands the destination to the native opener and never opens a
 * competing popup. Web prefers the Sidebar Browser for browsable schemes and
 * otherwise reserves a popup synchronously inside the click, replacing the
 * reservation's location once it is known to be usable.
 */
export class ExternalLinks {
  /** The popup reserved by the current gesture, if the browser granted one. */
  private reserved: ExternalLinkWindow | null = null

  /**
   * @param deps - native handoff, popup factory, Sidebar availability and
   * opener, destination preference, and refusal reporter.
   */
  constructor(private readonly deps: ExternalLinkDeps) {}

  /**
   * Reserve a popup for a destination that only arrives after an async step,
   * such as a Host-issued sign-in URL.
   * @returns the reserved popup, or null when the browser denied it.
   */
  begin(): ExternalLinkWindow | null {
    this.end()
    // Desktop hands the destination to the system browser, so a Web popup would
    // stay blank beside it.
    if (this.deps.native !== undefined) return null
    const popup = this.deps.openWindow('about:blank')
    // An embedded engine can answer a denied popup with nothing at all rather
    // than null; both mean the gesture got no browsing context.
    if (popup != null) popup.opener = null
    this.reserved = popup ?? null
    return this.reserved
  }

  /**
   * Close an unused reservation without closing a handed-off popup.
   * @returns nothing.
   */
  end(): void {
    const reserved = this.reserved
    this.reserved = null
    reserved?.close()
  }

  /**
   * Open one destination.
   * @param url - authored or host-supplied destination.
   * @param options - cancellation for a gesture that ends before the open.
   * @returns the destination that accepted the URL, or `'blocked'` for a refusal.
   */
  async open(url: string, options?: ExternalLinkOptions): Promise<ExternalLinkDestination> {
    options?.signal?.throwIfAborted()
    const notice = options?.notice ?? true
    const target = openableUrl(url)
    if (target === undefined) return this.refuse('unsupported', notice)
    const native = this.deps.native
    if (native !== undefined) {
      this.end()
      try {
        await native.openExternal(target.href)
      } catch (_error) {
        // The bridge refuses a destination its own allowlist rejects; report
        // that refusal instead of claiming the system browser opened it.
        return this.refuse(target.protocol === 'http:' || target.protocol === 'https:' ? 'nativeFailed' : 'unsupported', notice)
      }
      options?.signal?.throwIfAborted()
      return 'native'
    }
    const sidebar = this.deps.preference() === 'sidebar' && this.deps.sidebar()
      && BROWSE_SCHEMES.has(target.protocol)
    if (sidebar) {
      this.end()
      this.deps.openSidebar(target.href)
      return 'sidebar'
    }
    if (!BROWSE_SCHEMES.has(target.protocol)) {
      // A `mailto:` or `tel:` destination belongs to the program the browser
      // registered for it; an unused popup would stay blank behind the handoff.
      this.end()
      activateHandoff(target.href)
      return 'window'
    }
    const popup = this.reserved ?? this.deps.openWindow('about:blank')
    this.reserved = null
    if (popup == null || popup.closed) return this.refuse('blocked', notice)
    popup.opener = null
    popup.location.replace(target.href)
    return 'window'
  }

  /**
   * Report a refusal through the notice channel.
   * @param failure - refusal category.
   * @param notice - whether the shared notice publishes this refusal.
   * @returns `'blocked'`, so a caller returns it directly.
   */
  private refuse(failure: ExternalLinkFailure, notice: boolean): ExternalLinkDestination {
    if (notice) this.deps.report(failure)
    return 'blocked'
  }
}
