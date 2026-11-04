import { expect, it } from 'vitest'
import { ICON_SYMBOLS } from '@deepseek-ai/dsh-client-ui-primitives/src/icons/artwork.ts'
import { icons } from '../src/client/theme.ts'

it('replaces every upstream icon weight, including newly introduced glyphs', () => {
  expect(Object.keys(icons).sort()).toEqual(Object.keys(ICON_SYMBOLS).sort())
  for (const [key, original] of Object.entries(ICON_SYMBOLS)) {
    expect(icons[key as keyof typeof icons]).not.toBe(original)
  }
})
