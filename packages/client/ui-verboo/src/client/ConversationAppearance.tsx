/** Global conversation appearance uses the existing Host-backed product preferences. */
import { useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config } from '../config.ts'
import css from './StaminaDebug.module.css'

/** Appearance changes persist without replacing the current conversation views. */
export interface ConversationAppearanceInjected {
  hooks: { conversationAppearance: HostObservable<ConfigFormSnapshot<Pick<Config, 'minimalist'>>> }
  setMinimalist(enabled: boolean): Promise<boolean>
}
/** Localized presentation of the shared appearance preference. */
export type ConversationAppearanceProps = PropsLocale<'verboo'> & InjectFace<ConversationAppearanceInjected>

/** Persist one preference for all panes.
 * @param props - configuration observation and authorized write.
 * @returns the existing checkbox control style and recoverable save feedback. */
export function ConversationAppearance(props: ConversationAppearanceProps) {
  const setting = props.useConversationAppearance(state => state)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  return <div className={css.toggle}>
    <label>
      <span>{props.t('minimalistTitle')}</span>
      <input type="checkbox" checked={setting.value?.minimalist === true}
        disabled={saving || setting.status !== 'ready' || !setting.writable}
        onChange={(event) => {
          setSaving(true)
          setFailed(false)
          void props.setMinimalist(event.currentTarget.checked).then((ok) => {
            setFailed(!ok)
            setSaving(false)
          })
        }} />
    </label>
    <span>{props.t('minimalistDescription')}</span>
    {failed && <span role="alert">{props.t('minimalistSaveFailed')}</span>}
  </div>
}
