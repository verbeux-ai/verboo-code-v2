/** Neutral editor surfaces with a restrained Verboo accent and one icon family. */
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { IconSymbolId } from '@deepseek-ai/dsh-client-ui-primitives'
import { glyphs, replacements } from './icons.generated.ts'
const pair = (light: string, dark = light) => ({ light, dark })
const systemFont = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
/** Product colors preserve readable neutral surfaces in both user-selected themes. */
export const tokens: ThemeTokenOverrides = {
  '--verboo-accent': pair('#9340D4', '#B385DC'),
  '--verboo-accent-solid': pair('#242424', '#ECECEC'),
  '--verboo-on-accent': pair('#FFFFFF', '#1B1B1B'),
  '--verboo-accent-hover': pair('#3A3A3A', '#D4D4D4'),
  '--verboo-accent-wash': pair('#EFEFEF', '#303030'),
  '--verboo-bg': pair('#FFFFFF', '#212121'),
  '--verboo-surface': pair('#FFFFFF', '#292929'),
  '--verboo-subtle': pair('#F8F8F8', '#171717'),
  '--verboo-hover': pair('#F0F0F0', '#262626'),
  '--verboo-active': pair('#E7E7E7', '#303030'),
  '--dsw-alias-label-primary-foreground': pair('#FFFFFF', '#1B1B1B'),
  '--verboo-border': pair('#E8E8E8', '#383838'),
  '--verboo-ink': pair('#232323', '#ECECEC'),
  '--verboo-muted': pair('#707070', '#AAAAAA'),
  '--verboo-faint': pair('#929292', '#828282'),
  '--verboo-success': pair('#347453', '#81BB96'),
  '--verboo-error': pair('#B03846', '#E99B9B'),
  '--verboo-shadow': pair('0 12px 42px #00000014', '0 12px 42px #00000050'),
  '--dsw-alias-bg-base': pair('#FFFFFF', '#212121'),
  '--dsw-alias-bg-layer-1': pair('#FFFFFF', '#292929'),
  '--dsw-alias-bg-layer-2': pair('#F7F7F7', '#303030'),
  '--dsw-alias-bg-overlay': pair('#FFFFFF', '#2B2B2B'),
  '--dsw-specific-sidebar-fill': pair('#F8F8F8', '#171717'),
  '--dsw-alias-label-primary': pair('#232323', '#ECECEC'),
  '--dsw-alias-label-secondary': pair('#707070', '#AAAAAA'),
  '--dsw-alias-label-tertiary': pair('#818181', '#929292'),
  '--dsw-alias-border-l1': pair('#E8E8E8', '#383838'),
  '--dsw-alias-border-l2': pair('#DEDEDE', '#454545'),
  '--dsw-alias-border-l3': pair('#D8D8D8', '#4A4A4A'),
  '--dsw-alias-border-l4': pair('#E8E8E8', '#383838'),
  '--dsw-alias-brand-primary': pair('#9340D4', '#B385DC'),
  '--dsw-alias-brand-text': pair('#9340D4', '#B385DC'),
  '--dsw-alias-brand-primary-invert': pair('#FFFFFF', '#1B1B1B'),
  '--dsw-alias-button-primary-fill': pair('#242424', '#ECECEC'),
  '--dsw-alias-button-primary-hover': pair('#3A3A3A', '#D4D4D4'),
  '--dsw-alias-button-primary-dimmed': pair('#F0F0F0', '#363636'),
  '--dsw-alias-button-info-fill': pair('#242424', '#ECECEC'),
  '--dsw-alias-button-info-hover': pair('#3A3A3A', '#D4D4D4'),
  '--dsw-alias-interactive-bg-hover': pair('#EFEFEF', '#303030'),
  '--dsw-alias-interactive-bg-active': pair('#E7E7E7', '#373737'),
  '--dsw-alias-label-deep-diving': pair('#707070', '#AAAAAA'),
  '--dsw-alias-label-deep-diving-shimmer': pair('#A0A0A0', '#D2D2D2'),
  '--dsw-alias-label-primary-bluish': pair('#424242', '#D8D8D8'),
  '--dsw-specific-sidebar-nav-item-active-accent': pair('#EAEAEA', '#2E2E2E'),
  '--dsw-specific-sidebar-nav-item-active': pair('#EAEAEA', '#2E2E2E'),
  '--dsw-radius-panel': pair('20px'),
  '--dsw-mask-blur': pair('blur(2px)'),
  '--dsh-modal-enter-x': pair('0px'),
  '--dsh-modal-enter-y': pair('6px'),
  '--dsh-composer-card-max-width': pair('760px'),
  '--dsw-font-family-brand': pair(systemFont),
  '--dsh-font-family-text-default': pair(systemFont),
}
// Legacy color family names remain compatible; neutral values prevent broad tinted surfaces.
const neutral: Record<string, string> = {
  '50':'#FAFAFA', '75':'#F7F7F7', '100':'#F3F3F3', '150':'#EDEDED', '200':'#E5E5E5',
  '250':'#DCDCDC', '300':'#CECECE', '350':'#BDBDBD', '400':'#ABABAB', '450':'#969696',
  '500':'#818181', '550':'#707070', '600':'#606060', '650':'#525252', '700':'#454545',
  '750':'#393939', '800':'#303030', '850':'#282828', '900':'#202020', '950':'#171717',
}
for (const [step, value] of Object.entries(neutral))
  for (const family of ['blue', 'deepseek']) tokens[`--dsw-static-${family}-${step}`] = pair(value)
/** Complete replacement of the upstream sprite; product glyphs are monochrome. */
export const icons: Partial<Record<IconSymbolId, string>> = {}
for (const [name, replacement] of Object.entries(replacements))
  for (const weight of ['regular', 'medium']) {
    const id = `dsw-icon-${name}-${weight}` as IconSymbolId
    icons[id] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${glyphs[replacement]}</svg>`
  }
