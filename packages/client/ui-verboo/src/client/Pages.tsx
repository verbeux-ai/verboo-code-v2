import { useState } from 'react'
import { Modal, ShortcutKeys, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PageProps, ProductProps } from './contracts.ts'
import { Glyph } from './Glyph.tsx'
import { PageHead } from './PageParts.tsx'
import { StaminaDebugToggle, type StaminaDebugProps } from './StaminaDebug.tsx'
import { ConversationAppearance, type ConversationAppearanceProps } from './ConversationAppearance.tsx'
import { paneShortcutLabels } from './panes/shortcut-labels.ts'
import css from './Product.module.css'
/** Preferences are an ordinary page. Destructive session changes use one accessible confirmation. */
export function PreferencesPage(props: PageProps & StaminaDebugProps & ConversationAppearanceProps) {
  const state = props.useProduct(s => s)
  const preference = props.usePreferences(s => s)
  const [signOut, setSignOut] = useState(false)
  const shortcuts = paneShortcutLabels()
  return (
    <main className={css.page} data-verboo-page="preferences">
      <PageHead
        title={props.t('preferences')}
        description={props.t('accountDescription')}
        t={props.t}
        onClose={() => { props.selectPanel(null) }}
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
        <ConversationAppearance {...props} />
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
        <StaminaDebugToggle {...props} />
        <details className={css.shortcutDetails}>
          <summary>{props.t('paneShortcuts')}</summary>
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
