/**
 * Product-wide external link service. Every exit for an authored or
 * Host-supplied destination — Markdown anchors, tool rows, settings links,
 * plugin-market facts, context menus — calls `ctx.externalLinks.open()` so one
 * policy decides allowlisted schemes, the Sidebar Browser, the Desktop native
 * opener, and the refusal notice.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ExternalLinkDestination, ExternalLinkOptions } from './links.ts'
import { ExternalLinks } from './links.ts'
import type { ExternalLinkNoticeInjected, ExternalLinkNoticeState } from './notice.tsx'
import { ExternalLinkNotice } from './notice.tsx'
import { NS, de, en, es, fr, ja, pt, ru, zh, type ExternalLinksKey } from './locales.ts'

export type {
  ExternalLinkDestination,
  ExternalLinkFailure,
  ExternalLinkOptions,
  ExternalLinkWindow,
} from './links.ts'
export type { ExternalLinkNoticeInjected, ExternalLinkNoticeState } from './notice.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Refusal copy for a destination the product could not open. */
    externalLinks: ExternalLinksKey
  }
}

/** Ordinary-click destination for a browsable scheme. */
export type ExternalLinkPreference = 'sidebar' | 'new-tab'

/** The external link service consumers inject. */
export interface ExternalLinksService {
  /**
   * Open one destination.
   * @param url - authored or Host-supplied destination.
   * @param options - cancellation for a gesture that ends before the open.
   * @returns the destination that accepted the URL, or `'blocked'` for a refusal.
   */
  open(url: string, options?: ExternalLinkOptions): Promise<ExternalLinkDestination>
  /**
   * Reserve a popup for a destination that only arrives after an async Host step.
   * A denied reservation surfaces as `'blocked'` from the following `open()`.
   * @returns nothing.
   */
  begin(): void
  /** Close an unused reservation without closing a handed-off popup. */
  end(): void
  /**
   * Set the destination ordinary clicks prefer.
   * @param preference - Sidebar Browser or a separate browser window.
   */
  setPreference(preference: ExternalLinkPreference): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Product-wide external destination policy and its refusal notice. */
    externalLinks: ExternalLinksService
  }
}

declare global {
  /** Desktop bridge installed by the Tauri initialization script. */
  var __VERBOO_DESKTOP__: {
    readonly framework: 'tauri'
    readonly protocolVersion: number
    /** Host-reported runtime identity shown in the account sheet. */
    deviceInfo?(): Promise<string>
    /**
     * Open a destination in the system browser.
     * @param url - absolute URL the bridge allowlist accepts.
     * @returns a promise that settles after the native opener accepts it.
     */
    openExternal(url: string): Promise<void>
  } | undefined
}

/** The Browser page's open parameters, named here because this package owns no tab type. */
interface BrowserTabOpener {
  /** @param kind - the Browser page kind registered by `ui-sidebar-browser`. @param options - initial address. */
  openTab(kind: 'browser', options: { readonly params: { readonly url: string } }): void
}

/** Registry, copy, and the overlay seat used by the refusal notice. */
export const inject = ['slots', 'locale']

/**
 * Provide the service and register its refusal notice.
 * @param ctx - client plugin context carrying slots and locale.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'external-links: dictionaries')
  const notice = createSnapshotStore<ExternalLinkNoticeState | null>(null)
  let seq = 0
  let preference: ExternalLinkPreference = 'sidebar'
  // The Desktop bridge is read once per activation: it is installed by the
  // native initialization script before the client bundle runs, and a page
  // that reloads gets a fresh activation.
  const bridge = globalThis.__VERBOO_DESKTOP__
  const links = new ExternalLinks({
    native: bridge === undefined ? undefined : { openExternal: url => bridge.openExternal(url) },
    openWindow: url => window.open(url, '_blank'),
    sidebar: () => ctx.get('sidebarRightTabs')?.get('browser') !== undefined,
    openSidebar: (url) => { (ctx.get('sidebarRight') as BrowserTabOpener | undefined)?.openTab('browser', { params: { url } }) },
    preference: () => preference,
    report: (failure) => { seq += 1; notice.set({ failure, seq }) },
  })
  const dismiss = (): void => { notice.set(null) }
  ctx.provide('externalLinks', {
    open: (url, options) => links.open(url, options),
    begin: () => { links.begin() },
    end: () => { links.end() },
    setPreference: (value) => { preference = value },
  })
  ctx.effect(() => () => { links.end(); dismiss() }, 'external-links: browser reservations')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'external-links.notice', locale: NS,
    inject: (): ExternalLinkNoticeInjected => ({ hooks: { notice }, dismiss }),
  }, ExternalLinkNotice))
}
