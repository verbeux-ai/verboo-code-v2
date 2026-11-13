/**
 * Sign-in for the [OI] subscription the composer's limit reading belongs to.
 *
 * The flow asks for one thing at a time: a button that opens the provider's own
 * page, then the code the page leaves in the address bar. A callback listener
 * would be the alternative, and it would need a port this build does not serve,
 * so the code is pasted instead — the same shape every other device-code login
 * uses and the one that keeps working when the browser is on another machine.
 */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconLoadingOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OpenAiStatus } from './contracts.ts'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { Key } from './locales.ts'
import css from './OpenAiSignIn.module.css'

/** Actions the dialog drives; the page supplies them from the product face. */
export interface OpenAiSignInActions {
  /** Build the authorization URL and open it; undefined when the start failed. */
  readonly begin: () => Promise<{ url: string; handle: string } | undefined>
  /** Wait for the browser to reach the callback, then exchange its code. */
  readonly complete: (handle: string) => Promise<boolean>
  /** Remove the stored session. */
  readonly signOut: () => Promise<void>
  /** Close the dialog. */
  readonly close: () => void
}

/**
 * @param props - the stored status, the actions, and the locale seat.
 * @returns the sign-in dialog, or null while it is closed.
 */
export function OpenAiSignIn({ status, actions, open, t }: {
  status: OpenAiStatus
  actions: OpenAiSignInActions
  open: boolean
  t: (key: Key) => string
}) {
  if (!open) return null
  const [handle, setHandle] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const run = async (action: () => Promise<boolean>): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      if (!await action()) setFailed(true)
    } catch (_error) {
      setFailed(true) // The dialog reports an unsuccessful attempt beside the field it affects.
    } finally {
      setBusy(false)
    }
  }

  if (status.signedIn) {
    const plan = status.planType === undefined ? t('openAiPlan') : t('openAiPlanNamed').replace('{plan}', status.planType)
    return <Modal open onClose={actions.close} title={t('openAiSignedInTitle')} closeLabel={t('close')}>
      <div className={css.body}>
        <p className={css.summary}>{plan}</p>
        {status.activeUntil !== undefined && <p className={css.meta}>
          {t('openAiActiveUntil').replace('{date}', new Date(status.activeUntil).toLocaleDateString())}
        </p>}
        <div className={css.actions}>
          <Button variant="outline" onClick={actions.close}>{t('close')}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { void run(async () => {
            await actions.signOut()
            actions.close()
            return true
          }) }}>{t('openAiSignOut')}</Button>
        </div>
      </div>
    </Modal>
  }

  return <Modal open onClose={actions.close} title={t('openAiSignInTitle')} closeLabel={t('close')}>
    <div className={css.body}>
      <p className={css.description}>{t('openAiSignInDescription')}</p>
      {handle === null
        ? <Button variant="primary" disabled={busy} onClick={() => { void run(async () => {
          const started = await actions.begin()
          if (started === undefined) return false
          setHandle(started.handle)
          return true
        }) }}>
          {busy && <IconLoadingOutlineRegular size={14} />}{t('openAiSignInOpen')}
        </Button>
        : <>
          <p className={css.step}>{t('openAiWaiting')}</p>
          <div className={css.actions}>
            <Button variant="outline" onClick={actions.close}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => { void run(async () => {
              const done = await actions.complete(handle)
              if (done) actions.close()
              return done
            }) }}>{busy && <IconLoadingOutlineRegular size={14} />}{t('openAiFinish')}</Button>
          </div>
        </>}
      {failed && <p className={css.failure} role="alert">{t('openAiSignInFailed')}</p>}
    </div>
  </Modal>
}

/**
 * The frame-overlay entry: reads the stored status and the open flag from the
 * product stores, and drives the actions the product face exposes.
 * @param props - the overlay seat with the product hooks this dialog needs.
 * @returns the dialog while it is open, otherwise null.
 */
export function OpenAiSignInOverlay(
  props: PropsLocale<'verboo'> & {
    readonly useExternalStatus: SnapshotSelectorHook<OpenAiStatus>
    readonly useExternalDialogOpen: SnapshotSelectorHook<{ readonly open: boolean }>
    readonly openAiSignIn: OpenAiSignInActions
  },
) {
  const status = props.useExternalStatus(state => state)
  const open = props.useExternalDialogOpen(state => state.open)
  return <OpenAiSignIn status={status} actions={props.openAiSignIn} open={open} t={props.t} />
}
