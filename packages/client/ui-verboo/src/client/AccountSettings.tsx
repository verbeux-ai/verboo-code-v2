import { useEffect, useId, useState } from 'react'
import { Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProfileSettings } from '@deepseek-ai/dsh-api-verboo-product/types'
import type { PageProps } from './contracts.ts'
import css from './Product.module.css'

type AccountSettingsProps = Pick<PageProps, 't' | 'getProfileSettings' | 'updateProfileSettings' | 'updateAccountPassword'>

/** Editable account fields are loaded from, and saved to, the authenticated account. */
export function AccountSettings({ props, owner }: { props: AccountSettingsProps; owner: string }) {
  const [profile, setProfile] = useState<ProfileSettings | null>(null)
  const [name, setName] = useState('')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [passwordError, setPasswordError] = useState<'settingsPasswordMismatch' | 'settingsPasswordInvalid' | 'settingsSaveFailed' | null>(null)
  const passwordFormId = useId()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'saved' | 'failed' | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    void props.getProfileSettings().then((result) => {
      if (!active) return
      if (!result.ok || result.data.id !== owner) { setNotice('failed'); return }
      setProfile(result.data)
      setName(result.data.name)
    }).catch(() => { if (active) setNotice('failed') })
    return () => { active = false }
  }, [owner, reload])
  const saveProfile = async (input: { name?: string; publicProfile?: boolean }) => {
    setBusy(true); setNotice(null)
    try {
      const result = await props.updateProfileSettings({ owner, ...input })
      if (!result.ok || result.data.id !== owner) { setNotice('failed'); return }
      setProfile(result.data); setName(result.data.name); setNotice('saved')
    } catch { setNotice('failed') } finally { setBusy(false) }
  }
  const clearPasswordFields = () => {
    setCurrent('')
    setNext('')
    setConfirm('')
  }
  const closePassword = () => {
    if (busy) return
    clearPasswordFields()
    setPasswordError(null)
    setPasswordOpen(false)
  }
  const savePassword = async () => {
    if (busy || !profile) return
    if (next !== confirm) {
      setPasswordError('settingsPasswordMismatch')
      return
    }
    setBusy(true)
    setNotice(null)
    setPasswordError(null)
    try {
      const result = await props.updateAccountPassword({
        owner, ...(profile.hasPassword ? { currentPassword: current } : {}), newPassword: next,
      })
      if (!result.ok) {
        setPasswordError(result.code === 'incorrect_password' ? 'settingsPasswordInvalid' : 'settingsSaveFailed')
        return
      }
      setProfile(value => value && { ...value, hasPassword: true })
      setPasswordOpen(false)
      setNotice('saved')
    } catch {
      setPasswordError('settingsSaveFailed')
    } finally {
      clearPasswordFields()
      setBusy(false)
    }
  }
  if (!profile) return <section className={css.preferenceCard}>
    <p role="status">{notice === 'failed' ? props.t('settingsReadFailed') : props.t('loading')}</p>
    {notice === 'failed' && <button className={css.secondary} onClick={() => { setNotice(null); setReload(value => value + 1) }}>{props.t('retry')}</button>}
  </section>
  const passwordAction = props.t(profile.hasPassword ? 'settingsChangePassword' : 'settingsCreatePassword')
  return <>
    {notice && <p className={notice === 'saved' ? css.settingsSuccess : css.error} role="status">{props.t(
      notice === 'saved' ? 'settingsSaved' : 'settingsSaveFailed',
    )}</p>}
    <div className={css.preferenceCard}>
      <form className={css.settingsForm} onSubmit={(event) => { event.preventDefault(); void saveProfile({ name }) }}>
        <label>{props.t('settingsName')}<input value={name} onChange={(event) => { setName(event.target.value) }} maxLength={100} required autoComplete="name" /></label>
        <label>{props.t('settingsEmail')}<input value={profile.email} readOnly type="email" autoComplete="email" /></label>
        <button className={css.secondary} type="submit" disabled={busy || !name.trim() || name.trim() === profile.name}>{props.t('settingsSave')}</button>
      </form>
      <label className={css.settingsSwitch}><span>{props.t('settingsPublicProfile')}<small>{props.t('settingsPublicProfileDescription')}</small></span>
        <Switch
          className={css.settingsSwitchControl}
          label={props.t('settingsPublicProfile')}
          checked={profile.publicProfile}
          disabled={busy}
          onChange={(checked) => { void saveProfile({ publicProfile: checked }) }}
        />
      </label>
    </div>
    <section className={css.accountActionRow}>
      <h2>{props.t('settingsPassword')}</h2>
      <button className={css.secondary} type="button" aria-haspopup="dialog" disabled={busy} onClick={() => { setPasswordOpen(true) }}>
        {passwordAction}
      </button>
    </section>
    <Modal
      open={passwordOpen}
      onClose={closePassword}
      title={passwordAction}
      closeLabel={props.t('close')}
      className={css.confirmDialog ?? ''}
      footer={<>
        <button className={css.secondary} type="button" onClick={closePassword} disabled={busy}>{props.t('cancel')}</button>
        <button className={css.primary} type="submit" form={passwordFormId} disabled={busy}>{props.t('settingsSavePassword')}</button>
      </>}
    >
      <form id={passwordFormId} className={css.settingsForm} aria-busy={busy}
        onSubmit={(event) => { event.preventDefault(); void savePassword() }}>
        {profile.hasPassword && <label>
          {props.t('settingsCurrentPassword')}
          <input type="password" autoComplete="current-password" data-modal-autofocus="" required readOnly={busy}
            value={current} onChange={(event) => { setCurrent(event.target.value) }} />
        </label>}
        <label>
          {props.t('settingsNewPassword')}
          <input type="password" autoComplete="new-password" data-modal-autofocus={profile.hasPassword ? undefined : ''}
            required minLength={8} maxLength={128} readOnly={busy} value={next} onChange={(event) => { setNext(event.target.value) }} />
        </label>
        <label>
          {props.t('settingsConfirmPassword')}
          <input type="password" autoComplete="new-password" required minLength={8} maxLength={128}
            readOnly={busy} value={confirm} onChange={(event) => { setConfirm(event.target.value) }} />
        </label>
        {passwordError && <p className={css.error} role="alert">{props.t(passwordError)}</p>}
      </form>
    </Modal>
  </>
}
