/** Neutral editor surfaces with a restrained Verboo accent and one icon family. */
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { IconSymbolId } from '@deepseek-ai/dsh-client-ui-primitives'
import { glyphs, replacements } from './icons.generated.ts'
const pair = (light: string, dark = light) => ({ light, dark })
const systemFont = "'Verboo Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
/** Product colors preserve readable neutral surfaces in both user-selected themes. */
export const tokens: ThemeTokenOverrides = {
  '--verboo-accent': pair('#8E22D3', '#C078FF'),
  '--verboo-accent-solid': pair('hsl(275.9406 99.0196% 58%)'),
  '--verboo-on-accent': pair('#FFFFFF'),
  '--verboo-accent-hover': pair('hsl(275.9406 99.0196% 55%)'),
  '--verboo-accent-wash': pair('hsl(275.9406 99.0196% 60% / .10)'),
  '--verboo-bg': pair('#FFFFFF', '#0A0A0A'),
  '--verboo-surface': pair('#F8F8FA', '#171717'),
  '--verboo-subtle': pair('#FAFAFB', '#0A0A0A'),
  '--verboo-hover': pair('#F4F4F5', '#262626'),
  '--verboo-active': pair('hsl(275.9406 99.0196% 60% / .10)'),
  '--dsw-alias-label-primary-foreground': pair('#FFFFFF'),
  '--verboo-border': pair('#E4E4E7', '#282828'),
  '--verboo-ink': pair('#18181B', '#FAFAFA'),
  '--verboo-muted': pair('#71717A', '#A1A1A1'),
  '--verboo-faint': pair('#929292', '#828282'),
  '--verboo-success': pair('#347453', '#81BB96'),
  '--verboo-error': pair('#B03846', '#E99B9B'),
  '--verboo-shadow': pair('0 12px 42px #00000014', '0 12px 42px #00000050'),
  '--dsw-alias-bg-base': pair('#FFFFFF', '#0A0A0A'),
  '--dsw-alias-bg-layer-1': pair('#FFFFFF', '#171717'),
  '--dsw-alias-bg-layer-2': pair('#F7F7F8', '#262626'),
  '--dsw-alias-bg-overlay': pair('#FFFFFF', '#171717'),
  '--dsw-specific-sidebar-fill': pair('#FAFAFB', '#0A0A0A'),
  '--dsw-alias-label-primary': pair('#18181B', '#FAFAFA'),
  '--dsw-alias-label-secondary': pair('#71717A', '#A1A1A1'),
  '--dsw-alias-label-tertiary': pair('#81818B', '#A1A1A1'),
  '--dsw-alias-label-caption': pair('#71717A', '#A1A1A1'),
  '--dsw-alias-border-l1': pair('#E4E4E7', '#282828'),
  '--dsw-alias-border-l2': pair('#DEDEE3', '#343434'),
  '--dsw-alias-border-l3': pair('#D8D8DE', '#404040'),
  '--dsw-alias-border-l4': pair('#E4E4E7', '#282828'),
  '--dsw-alias-brand-primary': pair('hsl(275.9406 99.0196% 60%)'),
  '--dsw-alias-brand-text': pair('#8E22D3', '#C078FF'),
  '--dsw-alias-state-business-primary': pair('#8E22D3', '#C078FF'),
  '--dsw-alias-brand-primary-invert': pair('#FFFFFF'),
  '--dsw-alias-button-primary-fill': pair('hsl(275.9406 99.0196% 58%)'),
  '--dsw-alias-button-primary-hover': pair('hsl(275.9406 99.0196% 55%)'),
  '--dsw-alias-button-primary-dimmed': pair('#F0F0F0', '#363636'),
  '--dsw-alias-button-info-fill': pair('hsl(275.9406 99.0196% 58%)'),
  '--dsw-alias-button-info-hover': pair('hsl(275.9406 99.0196% 55%)'),
  '--dsw-alias-interactive-bg-hover': pair('#EFEFEF', '#303030'),
  '--dsw-alias-interactive-bg-active': pair('hsl(275.9406 99.0196% 60% / .10)'),
  '--dsw-alias-label-deep-diving': pair('#707070', '#AAAAAA'),
  '--dsw-alias-label-deep-diving-shimmer': pair('#A0A0A0', '#D2D2D2'),
  '--dsw-alias-label-primary-bluish': pair('#424242', '#D8D8D8'),
  '--dsw-specific-sidebar-nav-item-active-accent': pair('hsl(275.9406 99.0196% 60% / .10)'),
  '--dsw-specific-sidebar-nav-item-active': pair('hsl(275.9406 99.0196% 60% / .10)'),
  '--dsw-specific-input-major': pair('#FAFAFB', '#141414'),
  '--dsw-specific-bubble': pair('hsl(275.9406 99.0196% 58%)'),
  '--dsw-specific-bubble-foreground': pair('#FFFFFF'),
  '--dsh-composer-focus-stroke-color': pair('hsl(275.9406 99.0196% 60% / .45)'),
  '--dsh-composer-focus-ring-width': pair('2px'),
  '--dsh-composer-dock-min-height': pair('0px'),
  '--dsw-radius-panel': pair('22px'),
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
