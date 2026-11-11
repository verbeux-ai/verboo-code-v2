import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProductProps } from './contracts.ts'
import { Brand } from './Brand.tsx'
import { Glyph } from './Glyph.tsx'
import css from './Product.module.css'
/** One entry screen replaces the former multi-step credit onboarding. */
export function Onboarding(props: ProductProps) {
  const state = props.useProduct(s => s)
  const ref = useRef<HTMLDivElement>(null)
  const waitingForInitialProfileCheck = state.profile === null
    && (!state.profilePreviouslyVerified || state.accountFailed)
  const visible = state.view?.status !== 'credential-stored' || waitingForInitialProfileCheck
  useModalLayer(ref, visible, () => {})
  if (!visible) return null
  const phase = state.view?.attempt?.phase
  const pending =
    phase === 'initializing' ||
    phase === 'waiting-browser' ||
    phase === 'exchanging' ||
    phase === 'committing' ||
    state.starting
  const failed =
    state.actionFailed === 'sign-in' ||
    phase === 'failed' ||
    phase === 'expired'
  const stored = state.view?.status === 'credential-stored'
  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={props.t('product')}
      className={css.onboarding}
      data-verboo-onboarding
    >
      <section className={css.welcomeCopy}>
        <Brand t={props.t} large />
        <div className={css.welcomeBody}>
          <h1>{props.t('welcomeTitle')}</h1>
          <p className={css.welcomeDescription}>
            {props.t('welcomeDescription')}
          </p>
          <div className={css.loginArea}>
            {stored ? (
              <>
                {state.accountFailed ? (
                  <>
                    <p className={css.error} role="alert">
                      {props.t('accountLoadFailed')}
                    </p>
                    <button
                      className={css.primary}
                      onClick={props.retryAccount}
                    >
                      {props.t('retry')}
                      <Glyph name="rotate-cw" />
                    </button>
                    <button
                      className={css.textButton}
                      onClick={() => {
                        void props.signOut()
                      }}
                    >
                      {props.t('signOut')}
                    </button>
                  </>
                ) : (
                  <div className={css.waiting} role="status">
                    <Glyph name="loader-circle" className={css.spin} />
                    {props.t('checking')}
                  </div>
                )}
              </>
            ) : pending ? (
              <>
                <div className={css.waiting} role="status">
                  <Glyph name="loader-circle" className={css.spin} />
                  {props.t('waiting')}
                </div>
                <div className={css.inlineActions}>
                  <button className={css.secondary} onClick={props.reopen}>
                    {props.t('reopen')}
                    <Glyph name="arrow-up-right" />
                  </button>
                  <button className={css.textButton} onClick={props.cancel}>
                    {props.t('cancel')}
                  </button>
                </div>
              </>
            ) : (
              <button
                className={css.primary}
                disabled={!state.initialized}
                onClick={props.start}
              >
                {props.t('signIn')}
                <Glyph name="arrow-right" />
              </button>
            )}
            {state.accountFailed && !stored && (
              <p className={css.error} role="alert">
                {props.t('unavailable')}{' '}
                <button className={css.textButton} onClick={props.retryAccount}>
                  {props.t('retry')}
                </button>
              </p>
            )}
            {failed && (
              <p className={css.error} role="alert">
                {props.t('authFailed')}
              </p>
            )}
            {!stored && (
              <p className={css.fine}>
                <Glyph name="shield-check" size={14} />
                {props.t('secureBrowser')}
              </p>
            )}
          </div>
        </div>
        <p className={css.welcomeFoot}>{props.t('welcomeNote')}</p>
      </section>

    </div>,
    document.body,
  )
}
