/**
 * The sentence a reader sees when their plan does not serve the chosen model.
 *
 * It must name the remedy — another model — rather than a reset window, because
 * waiting never makes an unserved model available.
 */
import { describe, expect, it } from 'vitest'
import * as en from '../src/client/locale.ts'

/** Every dictionary the chat surface ships, in the order it declares them. */
const dictionaries = Object.entries(en).filter(([, value]) =>
  typeof value === 'object' && value !== null && 'message.failure.unsupportedModel' in value)

describe('unsupported-model copy', () => {
  it('ships the sentence in every language the surface registers', () => {
    // The surface registers eight dictionaries; a missing one is a compile
    // error as well, and this pins the count so the gate reports it too.
    expect(dictionaries.map(([name]) => name).sort())
      .toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
  })

  it('tells the reader to choose another model in each language', () => {
    for (const [name, dictionary] of dictionaries) {
      const copy = (dictionary as Record<string, string>)['message.failure.unsupportedModel']!
      expect(copy.length, name).toBeGreaterThan(20)
      // The remedy is another model; the copy must not promise a wait.
      expect(copy.toLowerCase(), name).not.toMatch(/try again in|wait|重试后|再試行/)
    }
  })

  it('never repeats the provider wording about the wire protocol', () => {
    for (const [name, dictionary] of dictionaries) {
      const copy = (dictionary as Record<string, string>)['message.failure.unsupportedModel']!
      expect(copy, name).not.toContain('Codex')
      expect(copy, name).not.toContain('not supported when using')
    }
  })
})
