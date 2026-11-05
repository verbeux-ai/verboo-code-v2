import { useState } from 'react'
import { Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PageProps, ProductProps } from './contracts.ts'
import type {
  Connection,
  Toolkit,
} from '@deepseek-ai/dsh-api-verboo-product/types'
import type { Key } from './locales.ts'
import { Glyph } from './Glyph.tsx'
import { PageHead, Notice, Busy } from './PageParts.tsx'
import css from './Product.module.css'
const serviceGlyphs: Record<string, Parameters<typeof Glyph>[0]['name']> = {
  github: 'git-branch', googledrive: 'folder', notion: 'file-code-2', slack: 'workflow',
  gmail: 'mail', googlecalendar: 'calendar-days', linear: 'kanban', figma: 'figma',
}
function ServiceIcon({ slug }: { slug: string }) {
  return <span className={css.serviceIcon}><Glyph name={serviceGlyphs[slug] ?? 'cable'} size={22}/></span>
}
const statusKey = (status: Connection['status']): Key => status

/** Users can authorize multiple accounts; every row keeps its own opaque connection identity. */
export function ConnectionsPage(props: PageProps) {
  const state = props.useProduct(s => s)
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(40)
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null)
  const [connecting, setConnecting] = useState<Toolkit | null>(null)
  const [label, setLabel] = useState('')
  const [authorizing, setAuthorizing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const data = state.connections
  const duplicate =
    data?.accounts.some(
      a =>
        a.toolkit === connecting?.slug &&
        a.label.toLocaleLowerCase() === label.trim().toLocaleLowerCase(),
    ) ?? false
  const authorize = async () => {
    if (!connecting) return
    setAuthorizing(true)
    try {
      if (await props.connect(connecting.slug, label.trim()))
        setConnecting(null)
    } finally {
      setAuthorizing(false)
    }
  }
  const tools =
    data?.toolkits.filter(t =>
      `${t.name} ${t.slug}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ) ?? []
  const confirm = async () => {
    if (!disconnecting) return
    setConfirming(true)
    try {
      if (await props.disconnect(disconnecting.id)) setDisconnecting(null)
    } finally {
      setConfirming(false)
    }
  }
  return (
    <main className={css.page} data-verboo-page="connections">
      <PageHead
        title={props.t('connections')}
        description={props.t('connectionsDescription')}
        t={props.t}
        onRefresh={props.loadConnections}
        loading={state.loadingConnections}
      />
      {state.connectionsFailed && (
        <Notice
          error
          text={props.t('connectionUnavailable')}
          retry={props.loadConnections}
          label={props.t('retry')}
        />
      )}
      {state.handoff === 'connection' && (
        <Notice
          text={props.t('connectionWebsite')}
          retry={props.loadConnections}
          label={props.t('refresh')}
        />
      )}
      {data === null ? (
        state.loadingConnections && <Busy label={props.t('loading')} />
      ) : (
        <>
          {!data.available && (
            <Notice text={props.t('connectionUnavailable')} />
          )}
          {data.accounts.length > 0 && (
            <section className={css.connectedSection}>
              <h2>{props.t('connected')}</h2>
              <div className={css.connectedList}>
                {data.accounts.map(account => (
                  <div className={css.connectedRow} key={account.id}>
                    <ServiceIcon slug={account.toolkit} />
                    <div className={css.connectionIdentity}>
                      <span>{account.label}</span>
                      <span className={css.connectionService}>
                        {data.toolkits.find(t => t.slug === account.toolkit)
                          ?.name ?? account.toolkit}
                      </span>
                      <span
                        className={css.connectionStatus}
                        data-status={account.status}
                      >
                        <i />
                        {props.t(statusKey(account.status))}
                      </span>
                    </div>
                    {state.authorizationIds.includes(account.id) &&
                      account.status !== 'connected' && (
                      <button
                        className={css.textButton}
                        onClick={() =>{  props.reopenConnection(account.id) }}
                      >
                        {props.t('reopen')}
                      </button>
                    )}
                    <button
                      className={css.textButton}
                      disabled={state.busy !== null}
                      onClick={() => {
                        props.dismiss()
                        setDisconnecting(account)
                      }}
                    >
                      {props.t('disconnect')}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className={css.catalogSection}>
            <div className={css.catalogHead}>
              <div className={css.catalogTitle}>
                <h2>{props.t('allTools')}</h2>
                <span>{props.t('catalogCount', { count: data.toolkits.length })}</span>
              </div>
              <label className={css.search}>
                <Glyph name="search" size={16} />
                <input
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setVisibleCount(40) }}
                  placeholder={props.t('searchConnections')}
                  aria-label={props.t('searchConnections')}
                />
              </label>
            </div>
            <div className={css.serviceGrid}>
              {tools.slice(0, visibleCount).map(toolkit => (
                <article className={css.serviceCard} key={toolkit.slug}>
                  <ServiceIcon slug={toolkit.slug} />
                  <div className={css.serviceIdentity}>
                    <h3>{toolkit.name}</h3>
                    {toolkit.authType && <p>{props.t(toolkit.authType === 'oauth' ? 'authOAuth' : toolkit.authType === 'none' ? 'authNone' : toolkit.authType === 'setup' ? 'authSetup' : 'authCredentials')}</p>}
                  </div>
                  {toolkit.authType === 'none' ? <span className={css.badge}>{props.t('publicAvailable')}</span> : <button
                    className={css.secondary}
                    disabled={!toolkit.available || state.busy !== null}
                    onClick={() => {
                      props.dismiss()
                      setConnecting(toolkit)
                      setLabel('')
                    }}
                    aria-label={`${props.t('connect')} ${toolkit.name}`}
                  >
                    {state.busy === toolkit.slug ? (
                      <Glyph
                        name="loader-circle"
                        className={css.spin}
                        size={15}
                      />
                    ) : (
                      <Glyph name="plus" size={15} />
                    )}{' '}
                    {props.t(toolkit.available ? 'connect' : 'authSetup')}
                  </button>}
                </article>
              ))}
            </div>
            {tools.length > 0 && <div className={css.catalogFooter}>
              <span aria-live="polite">{props.t('catalogShowing', { shown: Math.min(visibleCount, tools.length), total: tools.length })}</span>
              {visibleCount < tools.length && <button className={css.secondary} onClick={() => { setVisibleCount(count => count + 40) }}>{props.t('showMore')}</button>}
            </div>}
            {tools.length === 0 && (
              <p className={css.emptyText}>{props.t('noResults')}</p>
            )}
          </section>
          <p className={css.privacy}>
            <Glyph name="shield-check" size={16} />
            {props.t('connectionsPrivacy')}
          </p>
        </>
      )}
      <Modal
        open={
          disconnecting !== null &&
          data?.accounts.some(a => a.id === disconnecting.id) === true
        }
        onClose={() => {
          if (!confirming) setDisconnecting(null)
        }}
        title={props.t('disconnectTitle')}
        description={props.t('disconnectDescription')}
        closeLabel={props.t('close')}
        className={css.confirmDialog ?? ''}
        footer={
          <>
            <button
              className={css.secondary}
              disabled={confirming}
              onClick={() =>{  setDisconnecting(null) }}
            >
              {props.t('cancel')}
            </button>
            <button
              className={css.primary}
              disabled={confirming}
              onClick={() => {
                void confirm()
              }}
            >
              {props.t('confirmDisconnect')}
            </button>
          </>
        }
      >
        {disconnecting && (
          <p className={css.confirmIdentity}>{disconnecting.label}</p>
        )}
        {state.actionFailed === 'disconnect' && (
          <p className={css.error} role="alert">
            {props.t('disconnectFailed')}
          </p>
        )}
      </Modal>
      <Modal
        open={connecting !== null}
        onClose={() => {
          if (!authorizing) setConnecting(null)
        }}
        title={props.t('connectTitle')}
        description={props.t('connectDescription')}
        closeLabel={props.t('close')}
        className={css.confirmDialog ?? ''}
        footer={
          <>
            <button
              className={css.secondary}
              disabled={authorizing}
              onClick={() =>{  setConnecting(null) }}
            >
              {props.t('cancel')}
            </button>
            <button
              className={css.primary}
              disabled={authorizing || label.trim() === '' || duplicate}
              onClick={() => {
                void authorize()
              }}
            >
              {props.t('authorize')}
              <Glyph name="arrow-up-right" size={16} />
            </button>
          </>
        }
      >
        <div className={css.connectForm}>
          <p className={css.confirmIdentity}>{connecting?.name}</p>
          <label htmlFor="verboo-connection-name">
            {props.t('connectionName')}
          </label>
          <input
            id="verboo-connection-name"
            value={label}
            maxLength={64}
            placeholder={props.t('connectionNamePlaceholder')}
            onChange={(event) =>{  setLabel(event.target.value) }}
            data-modal-autofocus
          />
          {duplicate && (
            <p className={css.error} role="alert">
              {props.t('connectionNameUsed')}
            </p>
          )}
          {state.actionFailed === 'connect' && (
            <p className={css.error} role="alert">
              {props.t('connectFailed')}
            </p>
          )}
        </div>
      </Modal>
    </main>
  )
}
/** Preferences are an ordinary page. Destructive session changes use one accessible confirmation. */
export function PreferencesPage(props: PageProps) {
  const state = props.useProduct(s => s)
  const preference = props.usePreferences(s => s)
  const [signOut, setSignOut] = useState(false)
  return (
    <main className={css.page} data-verboo-page="preferences">
      <PageHead
        title={props.t('preferences')}
        description={props.t('accountDescription')}
        t={props.t}
      />
      <section className={css.preferenceCard}>
        <h2>{props.t('account')}</h2>
        <div className={css.accountRow}>
          <span className={css.accountAvatar}>
            {state.profile?.name?.slice(0, 1).toLocaleUpperCase() ?? (
              <Glyph name="circle-user-round" />
            )}
          </span>
          <div>
            <span>{state.profile?.name}</span>
            <p>{state.profile?.contact}</p>
          </div>
          <button className={css.secondary} onClick={() =>{  setSignOut(true) }}>
            {props.t('signOut')}
            <Glyph name="log-out" size={16} />
          </button>
        </div>
      </section>
      <section className={css.preferenceCard}>
        <h2>{props.t('appearance')}</h2>
        <div className={css.appearances}>
          {(['light', 'dark', 'system'] as const).map(mode => (
            <button
              key={mode}
              className={css.appearance}
              aria-pressed={preference.theme === mode}
              onClick={() =>{  props.setTheme(mode) }}
            >
              <span>
                <Glyph
                  name={
                    mode === 'light'
                      ? 'sun'
                      : mode === 'dark'
                        ? 'moon'
                        : 'monitor'
                  }
                  size={16}
                />
                {props.t(mode)}
                {preference.theme === mode && <Glyph name="check" size={15} />}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className={css.preferenceCard}>
        <div className={css.preferenceRow}>
          <label htmlFor="verboo-language">{props.t('language')}</label>
          <select
            id="verboo-language"
            value={preference.locale}
            onChange={(event) =>{  props.setLocale(event.target.value) }}
          >
            {preference.languages.map(locale => (
              <option key={locale.id} value={locale.id}>
                {locale.label}
              </option>
            ))}
          </select>
        </div>
        <button className={css.helpLink} onClick={props.help}>
          {props.t('help')}
          <Glyph name="arrow-up-right" size={16} />
        </button>
      </section>
      <Modal
        open={signOut && state.view?.status === 'credential-stored'}
        onClose={() =>{  setSignOut(false) }}
        title={props.t('signOutTitle')}
        description={props.t('signOutDescription')}
        closeLabel={props.t('close')}
        className={css.confirmDialog ?? ''}
        footer={
          <>
            <button className={css.secondary} onClick={() =>{  setSignOut(false) }}>
              {props.t('cancel')}
            </button>
            <button
              className={css.primary}
              disabled={state.busy !== null}
              onClick={() => {
                void props.signOut().then((success) => {
                  if (success) setSignOut(false)
                })
              }}
            >
              {props.t('confirmSignOut')}
            </button>
          </>
        }
      >
        {state.actionFailed === 'sign-out' && (
          <p className={css.error} role="alert">
            {props.t('actionFailed')}
          </p>
        )}
      </Modal>
    </main>
  )
}
export function Feedback(props: ProductProps) {
  const state = props.useProduct(s => s)
  return (
    <>
      {state.modelFailed && (
        <div className={css.modelNotice} role="alert">
          <Glyph name="triangle-alert" size={16} />
          <span>{props.t('modelUnavailable')}</span>
          <button
            className={css.textButton}
            disabled={state.initializingModel}
            onClick={props.retryModel}
          >
            {state.initializingModel ? (
              <Glyph name="loader-circle" className={css.spin} size={16} />
            ) : (
              props.t('retry')
            )}
          </button>
        </div>
      )}
      {state.navigationFailed && (
        <div className={css.feedback} role="alert">
          <Glyph name="external-link" size={18} />
          <span>
            {props.t(
              state.browserBlocked ? 'popupsBlocked' : 'navigationFailed',
            )}
          </span>
          <button
            className={css.iconButton}
            aria-label={props.t('dismiss')}
            onClick={props.dismiss}
          >
            <Glyph name="x" size={16} />
          </button>
        </div>
      )}
      {(state.actionFailed === 'global' || state.feedback) && (
        <Toast
          {...(state.actionFailed === 'global'
            ? { icon: <Glyph name="triangle-alert" size={18} /> }
            : { tone: 'success' as const })}
          text={props.t(
            state.actionFailed === 'global' ? 'actionFailed' : state.feedback ?? 'actionFailed',
          )}
          onDone={props.dismiss}
        />
      )}
    </>
  )
}
