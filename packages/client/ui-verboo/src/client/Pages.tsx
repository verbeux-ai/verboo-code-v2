import { useState } from 'react'
import { Modal, ShortcutKeys, Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PageProps, ProductProps } from './contracts.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { Glyph } from './Glyph.tsx'
import { AccountSettings } from './AccountSettings.tsx'
import { AppearanceSettings } from './AppearanceSettings.tsx'
import { PageHead } from './PageParts.tsx'
import { paneShortcutKeys } from './panes/shortcut-labels.ts'
import css from './Product.module.css'

type PreferencesProps = Pick<PageProps,
  't' | 'useProduct' | 'usePreferences' | 'getProfileSettings' | 'updateProfileSettings' | 'updateAccountPassword'
  | 'selectPanel' | 'setLocale' | 'setFontSize' | 'setTheme' | 'setConversationWidth'
  | 'openShortcuts' | 'help' | 'signOut' | 'signOutAll'>

/** Preferences are an ordinary page. Destructive session changes use one accessible confirmation. */
export function PreferencesPage(props: PreferencesProps) {
  const state = props.useProduct(s => s)
  const preference = props.usePreferences(s => s)
  const [signOut, setSignOut] = useState(false)
  const [signOutAll, setSignOutAll] = useState(false)
  const [signOutAllBusy, setSignOutAllBusy] = useState(false)
  const [signOutAllFailed, setSignOutAllFailed] = useState(false)
  const [notifications, setNotifications] = useState(() => localStorage.getItem('dsh.verboo.notifications.v1') === 'on')
  const [notificationsFailed, setNotificationsFailed] = useState(false)
  const [tab, setTab] = useState<'account' | 'general' | 'appearance'>('account')
  const shortcuts = paneShortcutKeys()
  return (
    <main className={`${css.page} ${css.profilePage}`} data-verboo-page="preferences" aria-label={props.t('preferences')} tabIndex={0}>
      <PageHead
        title={props.t('preferences')}
        description={props.t('accountDescription')}
        t={props.t}
        onClose={() => { props.selectPanel(null) }}
      />
      <nav className={css.settingsTabs} aria-label={props.t('preferences')}>
        {(['account', 'general', 'appearance'] as const).map(item => <button
          key={item} type="button" aria-current={tab === item ? 'page' : undefined}
          onClick={() => { setTab(item) }}
        >{props.t(item === 'general' ? 'settingsGeneral' : item === 'account' ? 'settingsAccount' : 'appearance')}</button>)}
      </nav>
      {tab === 'account' && <><section className={css.preferenceCard}>
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
        </div>
      </section>{state.profile?.id && <AccountSettings key={state.profile.id} props={props} owner={state.profile.id} />}
      <section className={css.accountActionRow}>
        <h2>{props.t('settingsSessions')}</h2>
        <div className={css.accountActions}>
          <button className={css.secondary} type="button" onClick={() => { setSignOut(true) }}>{props.t('signOut')}</button>
          <button className={css.secondary} type="button" onClick={() => { setSignOutAllFailed(false); setSignOutAll(true) }}>
            {props.t('settingsSignOutAll')}
          </button>
        </div>
      </section>
      <section className={css.accountActionRow}>
        <h2>{props.t('connections')}</h2>
        <button className={css.secondary} type="button" onClick={() => { props.selectPanel('verboo.connections' as MainPanelId) }}>
          {props.t('settingsManageConnections')}
        </button>
      </section>
      </>}
      {tab === 'appearance' && <AppearanceSettings props={props} preference={preference} />}
      {tab === 'general' && <><section className={css.preferenceCard}>
        <div className={css.settingsPreviewRow}>
          <span>{props.t('settingsDefaultFolder')}<small>{props.t('settingsDefaultFolderDescription')}</small></span>
          <button className={css.secondary} disabled>{props.t('settingsInDesign')}</button>
        </div>
        <div className={css.settingsPreviewRow}>
          <span>{props.t('settingsDefaultEditor')}<small>{props.t('settingsDefaultEditorDescription')}</small></span>
          <button className={css.secondary} disabled>{props.t('settingsInDesign')}</button>
        </div>
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
      </section>
      <section className={css.preferenceCard}>
        <label className={css.settingsSwitch}><span>{props.t('settingsNotifications')}<small>{props.t('settingsNotificationsDescription')}</small></span>
          <Switch
            className={css.settingsSwitchControl}
            label={props.t('settingsNotifications')}
            disabled={!globalThis.__VERBOO_DESKTOP__?.notificationPermission}
            checked={notifications}
            onChange={(enabled) => {
              if (!enabled) {
                localStorage.removeItem('dsh.verboo.notifications.v1')
                setNotifications(false)
                setNotificationsFailed(false)
                return
              }
              void globalThis.__VERBOO_DESKTOP__?.notificationPermission?.().then((granted) => {
                if (!granted) {
                  setNotificationsFailed(true)
                  return
                }
                localStorage.setItem('dsh.verboo.notifications.v1', 'on')
                setNotifications(true)
                setNotificationsFailed(false)
              }).catch(() => { setNotificationsFailed(true) })
            }}
          />
        </label>
        {!globalThis.__VERBOO_DESKTOP__?.notificationPermission && <small>{props.t('settingsInDesign')}</small>}
        {notificationsFailed && <p className={css.error} role="alert">{props.t('settingsNotificationsFailed')}</p>}
      </section>
      <section className={css.preferenceCard}>
        <button className={css.secondary} onClick={props.openShortcuts}>{props.t('settingsEditShortcuts')}</button>
        <details className={css.shortcutDetails}>
          <summary className={css.disclosureSummary}>
            <Glyph name="chevron-right" size={14} />
            <span>{props.t('paneShortcuts')}</span>
          </summary>
          <ul>
            {([
              ['paneSplitRight', shortcuts.right],
              ['paneSplitDown', shortcuts.down],
              ['paneMove', shortcuts.move],
              ['paneClose', shortcuts.close],
            ] as const).map(([label, keys]) => (
              <li key={label}><span>{props.t(label)}</span><ShortcutKeys keys={keys} /></li>
            ))}
          </ul>
        </details>
        <button className={css.helpLink} onClick={props.help}>
          {props.t('help')}
          <Glyph name="arrow-up-right" size={16} />
        </button>
      </section></>}
      <Modal open={signOutAll} onClose={() => { if (!signOutAllBusy) setSignOutAll(false) }}
        title={props.t('settingsSignOutAllTitle')} description={props.t('settingsSignOutAllDescription')}
        closeLabel={props.t('close')} className={css.confirmDialog ?? ''} footer={<>
          <button className={css.secondary} disabled={signOutAllBusy} onClick={() => { setSignOutAll(false) }}>{props.t('cancel')}</button>
          <button className={css.primary} disabled={signOutAllBusy} onClick={() => {
            const owner = state.profile?.id
            if (!owner) return
            setSignOutAllBusy(true)
            void props.signOutAll(owner).then((success) => { if (success) setSignOutAll(false); else setSignOutAllFailed(true) })
              .catch(() => { setSignOutAllFailed(true) }).finally(() => { setSignOutAllBusy(false) })
          }}>{props.t('settingsSignOutAll')}</button>
        </>}>
        {signOutAllFailed && <p className={css.error} role="alert">{props.t('actionFailed')}</p>}
      </Modal>
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
