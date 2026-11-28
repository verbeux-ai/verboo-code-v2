import { useState, type CSSProperties } from 'react'
import { CONVERSATION_WIDTHS, type ConversationWidth } from '../config.ts'
import type { PageProps, PreferenceSnapshot } from './contracts.ts'
import { Glyph } from './Glyph.tsx'
import type { Key } from './locales.ts'
import css from './Product.module.css'

type AppearanceProps = Pick<PageProps, 't' | 'setFontSize' | 'setTheme' | 'setConversationWidth'>

const fontPresets = [
  { text: 10, code: 10, terminal: 10 },
  { text: 12, code: 10, terminal: 11 },
  { text: 14, code: 11, terminal: 13 },
  { text: 18, code: 13, terminal: 16 },
  { text: 22, code: 16, terminal: 20 },
] as const
const fontLabelKeys = ['settingsFontVerySmall', 'settingsFontSmall', 'settingsFontMedium', 'settingsFontLarge', 'settingsFontVeryLarge'] as const satisfies readonly Key[]
const widthOptions = [
  ['narrow', 'settingsWidthNarrow'],
  ['standard', 'settingsWidthStandard'],
  ['wide', 'settingsWidthWide'],
] as const

function closestFontPreset(sizes: PreferenceSnapshot['fontSizes']): number {
  const distance = (preset: PreferenceSnapshot['fontSizes']) => (preset.text - sizes.text) ** 2
    + (preset.code - sizes.code) ** 2 + (preset.terminal - sizes.terminal) ** 2
  return fontPresets.reduce(
    (best, preset, index) => distance(preset) < distance(fontPresets[best] ?? fontPresets[0]) ? index : best,
    0,
  )
}

/** Appearance preferences and an inline sample of the selected theme, size and width. */
export function AppearanceSettings({ props, preference }: { props: AppearanceProps; preference: PreferenceSnapshot }) {
  const { t, setFontSize, setTheme, setConversationWidth } = props
  const [pendingWidth, setPendingWidth] = useState<ConversationWidth | null>(null)
  const [widthFailed, setWidthFailed] = useState(false)
  const width = pendingWidth ?? preference.conversationWidth
  const fontLevel = closestFontPreset(preference.fontSizes)
  const fontLabel = t(fontLabelKeys[fontLevel] ?? fontLabelKeys[2])
  const applyFontPreset = (preset: PreferenceSnapshot['fontSizes']) => {
    setFontSize('text', preset.text)
    setFontSize('code', preset.code)
    setFontSize('terminal', preset.terminal)
  }
  const applyWidth = async (next: ConversationWidth) => {
    if (pendingWidth !== null || next === width) return
    setPendingWidth(next)
    setWidthFailed(false)
    try {
      if (!(await setConversationWidth(next))) setWidthFailed(true)
    } catch {
      setWidthFailed(true)
    } finally {
      setPendingWidth(null)
    }
  }
  const previewStyle = {
    '--preview-width': `${CONVERSATION_WIDTHS[width] / CONVERSATION_WIDTHS.wide * 100}%`,
    '--preview-text-size': `${preference.fontSizes.text}px`,
    '--preview-code-size': `${preference.fontSizes.code}px`,
    '--preview-terminal-size': `${preference.fontSizes.terminal}px`,
  } as CSSProperties

  return <div className={css.appearanceLayout}>
    <div>
      <section className={css.preferenceCard}>
        <h2>{t('appearance')}</h2>
        <div className={css.appearances}>
          {(['light', 'dark', 'system'] as const).map(mode => (
            <button key={mode} type="button" className={css.appearance}
              aria-pressed={preference.theme === mode} onClick={() => { setTheme(mode) }}>
              <span>
                <Glyph name={mode === 'light' ? 'sun' : mode === 'dark' ? 'moon' : 'monitor'} size={16} />
                {t(mode)}
                {preference.theme === mode && <Glyph name="check" size={15} />}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className={css.preferenceCard}>
        <h2>{t('settingsFontSizes')}</h2>
        <div className={css.fontScale}>
          <div className={css.fontScaleHeading}><span>{t('settingsFontPreview')}</span><span>{fontLabel}</span></div>
          <div className={css.fontScaleControl} style={{ '--font-scale-progress': `${fontLevel * 25}%` } as CSSProperties}>
            <span className={css.fontScaleSmall} aria-hidden="true">{t('settingsPreviewGlyph')}</span>
            <div className={css.fontScaleTrack}>
              <div className={css.fontScaleStops} aria-hidden="true">
                {fontPresets.map((_, i) => <span key={i} data-passed={i <= fontLevel} />)}
              </div>
              <input type="range" min={0} max={4} step={1} value={fontLevel} aria-label={t('settingsFontSizes')}
                aria-valuetext={fontLabel} onChange={(event) => {
                  const preset = fontPresets[event.target.valueAsNumber]
                  if (preset) applyFontPreset(preset)
                }} />
            </div>
            <span className={css.fontScaleLarge} aria-hidden="true">{t('settingsPreviewGlyph')}</span>
          </div>
        </div>
        <button className={css.secondary} type="button" onClick={() => { applyFontPreset(fontPresets[2]) }}>
          {t('settingsRestoreSizes')}
        </button>
      </section>
      <section className={css.preferenceCard}>
        <h2>{t('settingsConversationWidth')}</h2>
        <div className={css.appearances} role="group" aria-label={t('settingsConversationWidth')} aria-busy={pendingWidth !== null}>
          {widthOptions.map(([option, label]) => <button key={option} type="button" className={css.appearance}
            aria-pressed={width === option} disabled={!preference.canSetConversationWidth || pendingWidth !== null}
            onClick={() => { void applyWidth(option) }}>
            <span>{t(label)}</span>
          </button>)}
        </div>
        {widthFailed && <p role="alert" className={css.error}>{t('settingsSaveFailed')}</p>}
      </section>
    </div>
    <section className={css.preferenceCard}>
      <h2>{t('settingsLivePreview')}</h2>
      <div className={css.appearancePreview} style={previewStyle}>
        <div className={css.appearanceSample}>
          <p>{t('settingsPreviewMessage')}</p>
          <pre aria-label={t('settingsCodeSize')}><code>{t('settingsPreviewCode')}</code></pre>
          <pre aria-label={t('settingsTerminalSize')}><code><span aria-hidden="true">$</span> {t('settingsPreviewCommand')}</code></pre>
        </div>
      </div>
    </section>
  </div>
}
