/**
 * Level vocabulary coverage.
 *
 * The Host names a level by an adapter-owned id, and this Client sees ids from
 * three vocabularies: `llm-deepseek`'s four, the backend's `none`…`xhigh` set,
 * and whatever a pi-ai route passes through. A known id must read in the
 * reader's language; an id this vocabulary does not name must keep the Host's
 * own words, because only the Host knows what that level means.
 */
import { describe, expect, it } from 'vitest'
import { effortDescription, effortName } from '../src/client/effort-levels.ts'
import { en, pt, zh, ja, es, fr, de, ru, type ModelKey } from '../src/client/locales.ts'

/** Every shipped dictionary, named for the failure message. */
const DICTIONARIES: ReadonlyArray<readonly [string, Record<ModelKey, string>]> = [
  ['en', en], ['pt', pt], ['zh', zh], ['ja', ja], ['es', es], ['fr', fr], ['de', de], ['ru', ru],
]

/** Level ids the Host may advertise. */
const KNOWN = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Translate through one dictionary, the way the renderer's `t` seat does. */
const translator = (dictionary: Record<ModelKey, string>) => (key: ModelKey) => dictionary[key]

describe('effort level vocabulary', () => {
  it('names every known level in every language', () => {
    for (const [language, dictionary] of DICTIONARIES) {
      for (const id of KNOWN) {
        const name = effortName({ id, name: 'HostWording' }, translator(dictionary))
        const description = effortDescription({ id, name: 'HostWording' }, translator(dictionary))
        expect(name, `${language} ${id}`).not.toBe('HostWording')
        expect(name.trim(), `${language} ${id} name empty`).not.toBe('')
        expect(description, `${language} ${id} description`).toBeTruthy()
      }
    }
  })

  it('gives every level a distinct name within one language', () => {
    // A model advertising all seven must not show two equal stops.
    for (const [language, dictionary] of DICTIONARIES) {
      const names = KNOWN.map(id => effortName({ id, name: id }, translator(dictionary)))
      expect(new Set(names).size, `${language}: ${names.join(', ')}`).toBe(KNOWN.length)
    }
  })

  it('gives every level a distinct explanation within one language', () => {
    for (const [language, dictionary] of DICTIONARIES) {
      const texts = KNOWN.map(id => effortDescription({ id, name: id }, translator(dictionary)))
      expect(new Set(texts).size, language).toBe(KNOWN.length)
    }
  })

  it('matches a Host id whatever its case or surrounding space', () => {
    for (const id of ['HIGH', 'High', ' high ', 'hIgH']) {
      expect(effortName({ id, name: 'HostWording' }, translator(pt)), id).toBe('Alto')
    }
  })

  it('keeps the Host wording for a level this vocabulary does not name', () => {
    const effort = { id: 'turbo', name: 'Turbo', description: 'A level the adapter invented.' }
    // Only the Host knows what its own level means, so its words survive.
    expect(effortName(effort, translator(pt))).toBe('Turbo')
    expect(effortDescription(effort, translator(pt))).toBe('A level the adapter invented.')
  })

  it('reports no explanation when the Host supplied none for an unknown level', () => {
    expect(effortDescription({ id: 'turbo', name: 'Turbo' }, translator(pt))).toBeUndefined()
  })

  it('localizes the Portuguese rail the product ships', () => {
    // The product's own language reads the four levels llm-deepseek advertises.
    expect(KNOWN.slice(0, 1).map(id => effortName({ id, name: id }, translator(pt)))).toEqual(['Desligado'])
    expect(effortName({ id: 'low', name: 'low' }, translator(pt))).toBe('Leve')
    expect(effortName({ id: 'high', name: 'high' }, translator(pt))).toBe('Alto')
    expect(effortName({ id: 'max', name: 'max' }, translator(pt))).toBe('Máximo')
    expect(effortDescription({ id: 'high', name: 'high' }, translator(pt)))
      .toBe('O equilíbrio padrão para a maioria das tarefas.')
  })

  it('never leaves a known level untranslated in a non-English dictionary', () => {
    const english = KNOWN.map(id => effortName({ id, name: id }, translator(en)))
    for (const [language, dictionary] of DICTIONARIES) {
      if (language === 'en') continue
      const names = KNOWN.map(id => effortName({ id, name: id }, translator(dictionary)))
      // Every level differs from English, so no dictionary silently falls back.
      expect(names, language).not.toEqual(english)
    }
  })
})
