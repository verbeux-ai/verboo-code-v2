/** Committed install icon dimensions and the generator's SVG crop and safe-zone scale. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, MASKABLE_ARTWORK_SCALE, TILE_SOURCE,
  maskableDocument, tileDocument,
} from '../scripts/render-app-icons.ts'
import { pngSize } from './png-size.ts'

describe('web install icons', () => {
  it('ships every declared variant at its declared edge', async () => {
    for (const variant of APP_ICON_VARIANTS) {
      expect(pngSize(await readFile(join(ICON_OUTPUT_DIRECTORY, variant.file))))
        .toEqual([variant.size, variant.size])
    }
  })

  it('crops the canvas to the tile and scales only the maskable artwork', async () => {
    const source = await readFile(TILE_SOURCE, 'utf8')
    const tile = tileDocument(source)
    const maskable = maskableDocument(source)
    // The icon canvas is exactly the opaque tile, at the tile's own extent.
    expect(tile).toContain('viewBox="0 0 1024 1024"')
    expect(tile).toContain('<g data-app-artwork="verboo">')
    expect(tile).toContain('<image')
    // The tile itself carries no maskable scale: only the maskable variant scales.
    expect(tile).not.toContain(`scale(${MASKABLE_ARTWORK_SCALE})`)
    // Only the artwork scales into the safe zone a platform mask may crop; the
    // opaque background keeps the tile's full extent.
    expect(maskable).toContain(`transform="translate(512 512) scale(${MASKABLE_ARTWORK_SCALE}) translate(-512 -512)"`)
    expect(maskable).toContain('<image')
  })

  it('rejects non-PNG bytes and incomplete image headers', () => {
    expect(() => pngSize(Buffer.from('<svg/>'))).toThrow(/PNG IHDR/)
    expect(() => pngSize(Buffer.alloc(33))).toThrow(/PNG IHDR/)
  })

  it('fails loudly on a source without the tile it transforms', () => {
    expect(() => tileDocument('')).toThrow(/no root element/)
    expect(() => tileDocument('<svg></svg>')).toThrow(/no artwork group/)
    expect(() => maskableDocument('<svg><g filter="url(#filter0_d_1637_371)"></g></svg>'))
      .toThrow(/no artwork group/)
  })
})
