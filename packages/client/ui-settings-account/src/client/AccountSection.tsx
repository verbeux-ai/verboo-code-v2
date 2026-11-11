/** Account settings renders safe Host state and explicit login actions. */
import { Big } from 'big.js'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Button, IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountDetails, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PropsRuntime, PropsLocale, InjectFace, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PlatformPage, PlatformPages } from './platform-pages.ts'
import { formatBalance } from './formatBalance.ts'
import { AccountAvatar } from './AccountAvatar.tsx'
import type { AccountAvatarSnapshot } from './account-avatar.ts'
import { authorizeUrlWithTheme } from './authorize-url.ts'
import type { BonusNotice } from './bonus-notices.ts'
import css from './AccountSection.module.css'
// Type-only: the optional `ctx.externalLinks` service merge read below.
import type {} from '@deepseek-ai/dsh-client-external-links/client'

/** Safe account snapshot shared by the settings page and launcher. */
export interface AccountSnapshot {
  /** Server-authored notices in front-to-back order, absent when none are available. */
  notices?: readonly BonusNotice[]

  /** Latest Host state, absent until the stream responds. */
  view: AccountView | undefined
  /** Sanitized profile and balance query outcomes, absent while loading. */
  details: Partial<AccountDetails> | undefined
  /** Shared picture load; absent until a profile supplies a picture or after sign-out. */
  avatar: AccountAvatarSnapshot | undefined
  /** Whether the state stream failed. */
  failed: boolean
  /** Explicitly opened account dialog outside onboarding. */
  loginVisible?: boolean
  /** Latest explicit start request failed before a Host state was available. */
  loginFailed?: boolean
  /** Model credential onboarding owns the login dialog and delays bonus notices while mounted. */
  onboarding?: boolean
  /** Desktop introduction covers the workspace during loading, saving, and exit animation.
   * True on Desktop until shell.overlay reports visibility, false in browsers; Desktop layouts must render that slot.
   */
  desktopOnboardingVisible?: boolean
}

/** Host operations injected into the Cordis-free account component. */
export interface AccountSectionInjected {
  /** @param snapshot - picture attempt whose rendered image failed; superseded attempts are ignored. */
  avatarFailed: (snapshot: AccountAvatarSnapshot) => void
  /** Subscribe to live credential-expiry notifications.
   * @param listener - callback after the current credential is removed.
   * @returns listener cleanup.
   */
  subscribeSessionExpired?: (listener: () => void) => () => void
  /** Subscribe to live model sign-in guidance; the returned function removes the listener.
   * @param listener - callback for one rejected account-model request.
   * @returns listener cleanup.
   */
  subscribeModelSignInRequired?: (listener: () => void) => () => void
  /** Desktop-only: show one page in the account feature's shared native host; absent in ordinary browsers. */
  openPlatformPage?: PlatformPages['open']
  /**
   * Ordinary activation of a Platform destination, through the product link service.
   * @param url - absolute destination from the account links.
   */
  openExternalLink: (url: string) => void

  /** Account stream owned by the Host and theme snapshots published by the renderer, observed through framework hooks. */
  hooks: {
    account: HostObservable<AccountSnapshot>
    /** Palette the Platform login pages follow. */
    theme: HostObservable<ThemeSnapshot>
  }
  /**
   * Retry a failed avatar and read the profile, balance, bonus wallets and unnotified bonus once. The Settings launcher
   * calls it on each entry, and a page opener on return from top-up.
   * @returns after the account queries settle; image loading completes independently.
   */
  refreshAccount: () => Promise<void>
  /** Open the external support questionnaire with the account, build and environment sampled by this click. */
  contactUs: () => void
  /** Open or dismiss the login dialog. */
  showLogin: (visible: boolean) => void
  /** Claim dialog ownership for the onboarding step. */
  setOnboarding: (active: boolean) => void
  /** @param orderId - notice whose card finished a presented frame while visible. */
  bonusNoticeShown: (orderId: BonusNotice['orderId']) => void
  /** @param orderId - notice the user closed. */
  bonusNoticeDismissed: (orderId: BonusNotice['orderId']) => void
  /** @returns after the login attempt is created. */
  start: () => Promise<void>
  /** @param id - attempt to cancel. @returns after cancellation or an already-admitted commit. */
  cancel: (id: SignInAttemptId) => Promise<void>
  /** @returns whether a running task currently uses the account token. */
  hasRunningAccountTasks: () => Promise<boolean>
  /** @returns after local account credentials are removed. */
  signOut: () => Promise<void>
}
/** Composed account section props. */
export type AccountSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>
/** @param props - localized actions, account subscription, and the shared Platform page channel. @returns account settings UI. */
export function AccountSection({
  t, useAccount, useTheme, start, cancel, openPlatformPage, openExternalLink, avatarFailed,
}: AccountSectionProps) {
  const { view: state, details, avatar, failed: streamFailed } = useAccount(value => value)
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  // The shared host owns the native view; this page holds only its own request,
  // and only while it is the latest owner.
  const releasePage = useRef<(() => void) | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const profile = details?.profile?.status === 'ready' ? details.profile.value : undefined
  const wallets = details?.balance?.status === 'ready' ? details.balance.value : undefined
  const bonusWallets = details?.balance?.status === 'ready'
    ? details.balance.bonusWallets.filter(wallet => new Big(wallet.balance).gt(0)) : []
  const showBonusRow = details?.balance?.status !== 'ready' || bonusWallets.length > 0
  const attempt = state?.attempt
  const active = attempt !== null && attempt !== undefined
    && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(attempt.phase)
  // A narrowed const keeps the property's refinement inside the anchor's click closure.
  const authorizeUrl = attempt?.authorizeUrl
  const signedIn = state?.status === 'credential-stored'
  useEffect(() => () => { releasePage.current?.(); releasePage.current = undefined }, [])
  useEffect(() => {
    if (signedIn) return
    releasePage.current?.()
    releasePage.current = undefined
  }, [signedIn])
  const showPage = (open: PlatformPages['open'], page: PlatformPage) => {
    releasePage.current?.()
    releasePage.current = open(page, () => { releasePage.current = undefined })
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setFailed(false)
    try { await action() } catch { setFailed(true) } finally { setBusy(false) }
  }
  /**
   * Route a Platform destination through the embedded page on Desktop and the
   * product link service elsewhere. Modified clicks keep native behavior, and a
   * read that has not produced a link yet leaves the click inert.
   * @param event - click on a Platform destination link.
   * @param page - embedded page to show instead of leaving the app.
   * @param url - destination the anchor carries, absent before the read lands.
   * @returns nothing.
   */
  const openPlatform = (event: MouseEvent<HTMLAnchorElement>, page: PlatformPage, url: string): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    if (openPlatformPage !== undefined && signedIn) { showPage(openPlatformPage, page); return }
    openExternalLink(url)
  }
  /**
   * Send a destination the sheet shows outside the embedded Platform pages.
   * @param event - click on the anchor carrying it.
   * @param url - destination the anchor carries.
   * @returns nothing.
   */
  const openElsewhere = (event: MouseEvent<HTMLAnchorElement>, url: string): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    openExternalLink(url)
  }
  /**
   * The Platform entry the balance rows share with the Usage action: an embedded page on
   * Desktop, a new tab elsewhere. A wallet read that failed still reaches the same
   * destination, so the user can inspect the balance the Harness could not load; the
   * destination comes from the account links, not from the wallet response.
   * @param label - localized link copy.
   * @param className - link treatment for the row that renders it, absent when the sheet has no such rule.
   * @returns the Platform anchor.
   */
  // The signed-out branch above returns without a read, so every anchor below has one.
  const links = state?.links ?? { usageUrl: '', topUpUrl: '' }
  const platformLink = (label: string, className: string | undefined) => (
    <a className={className} href={links.usageUrl} target="_blank" rel="noreferrer"
      onClick={(event) => { openPlatform(event, 'usage', links.usageUrl) }}>{label}</a>
  )
  const status = failed || streamFailed || attempt?.phase === 'failed' ? t('failed')
    : attempt?.phase === 'expired' ? t('expired')
      : active ? t(attempt.phase === 'initializing' ? 'initializing' : attempt.phase === 'waiting-browser' ? 'waiting' : 'completing')
        : signedIn ? profile?.contact ?? t(details?.profile === undefined ? 'loading' : 'profileUnavailable') : t('signInDescription')
  if (!signedIn && !active) return (
    <section className={css.signedOut} aria-label={t('nav')}>
      <div className={css.signedOutContent}>
        <div className={css.signedOutCopy}>
          <span className={css.signedOutTitle}>{t('settingsSignedOutTitle')}</span>
          <span className={css.signedOutDescription} role="status">
            {failed || streamFailed ? t('failed') : t('settingsSignedOutDescription')}
          </span>
        </div>
        <Button variant="primary" className={css.signInButton} disabled={busy || state === undefined}
          onClick={() => { void run(start) }}>{t('signIn')}</Button>
      </div>
    </section>
  )
  return (
    <section className={css.section} aria-label={t('nav')}>
      <div className={css.card}>
        <div className={css.identity}>
          <span className={css.avatar} data-avatar-status={signedIn ? avatar?.status : undefined}>
            <AccountAvatar avatar={signedIn ? avatar : undefined} avatarFailed={avatarFailed} />
          </span>
          <div className={css.identityCopy}>
            <span className={css.name}>{signedIn ? profile?.name ?? t('signedIn') : t('signedOut')}</span>
            <span className={css.status} role="status">{status}</span>
          </div>
        </div>
        {signedIn && <a className={css.accountInfo} href={new URL('/', links.usageUrl).href} target="_blank" rel="noopener noreferrer"
          onClick={(event) => { openElsewhere(event, new URL('/', links.usageUrl).href) }}>
          {t('accountInfo')}<IconRightUpOutlineRegular size={12} />
        </a>}
      </div>
      {active && <div className={css.actions}>
        {authorizeUrl !== undefined && <a className={css.linkButton} href={authorizeUrlWithTheme(authorizeUrl, colorScheme)}
          target="_blank" rel="noreferrer"
          onClick={(event) => { openElsewhere(event, authorizeUrlWithTheme(authorizeUrl, colorScheme)) }}>
          {t('open')}
        </a>}
        <Button variant="outline" disabled={busy || attempt.phase === 'committing'}
          onClick={() => { void run(() => cancel(attempt.id)) }}>{t('cancel')}</Button>
      </div>}
      <div className={css.balanceCard}>
        <div className={css.row}>
          <span>{t('balance')}</span>
          {signedIn && wallets !== undefined && wallets.length > 0
            ? <span className={css.amount}>{wallets.map(wallet => <span key={wallet.currency}>
              {formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')}
            </span>)}</span>
            : !signedIn || details?.balance === undefined
              ? <span className={css.unavailable}>{t(!signedIn ? 'balanceSignedOut' : 'loading')}</span>
              : platformLink(t('balanceUnavailable'), css.unavailableLink)}
        </div>
        {signedIn && showBonusRow && <>
          <div className={css.divider} />
          <div className={css.row}>
            <span>{t('bonusBalance')}</span>
            <span className={css.bonusValue}>
              {bonusWallets.length > 0
                ? <span className={css.amount}>{bonusWallets.map(wallet => <span key={wallet.currency}>
                  {formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')}
                </span>)}</span>
                : details?.balance === undefined
                  ? <span className={css.unavailable}>{t('loading')}</span>
                  : platformLink(t('balanceUnavailable'), css.unavailableLink)}
            </span>
          </div>
        </>}
        <div className={css.divider} />
        <div className={css.row}>
          <span className={css.secondary}>{t('more')}</span>
          <div className={css.links}>
            {platformLink(t('usage'), css.linkButton)}
            <a className={`${css.linkButton} ${css.primary}`} href={links.topUpUrl}
              target="_blank" rel="noreferrer"
              onClick={(event) => { openPlatform(event, 'top-up', links.topUpUrl) }}>{t('topUp')}</a>
          </div>
        </div>
      </div>
    </section>
  )
}
