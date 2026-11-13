/**
 * Model listing translation.
 *
 * The router advertises the reasoning levels it accepts. The selector's effort
 * pane renders only for a model that declares levels, so a listing that loses
 * them hides the control entirely on an account route.
 */
import { describe, expect, it } from 'vitest'
import { parseModels } from '../src/models.ts'
import type { Deployment } from '../src/config.ts'

/** Conservative defaults a legacy listing without capability metadata receives. */
const deployment = {
  fallbackContextWindow: 128_000,
  fallbackMaxOutputTokens: 8_192,
} as Deployment

/**
 * Parse one listed row.
 * @param reasoning - the router's reasoning field for that row.
 * @returns the transport profile the adapter receives.
 */
function parse(reasoning: unknown) {
  return parseModels({
    data: [{
      id: 'pro/deepseek-v4.1-flash',
      display_name: 'deepseek-v4.1-flash',
      context_window: 128_000,
      max_output_tokens: 8_192,
      reasoning,
    }],
  }, deployment)[0]!
}

describe('reasoning levels from the router', () => {
  it('maps every accepted level to its own wire spelling', () => {
    // Without this the profile carries only a flag, the adapter finds no
    // installed catalog entry for the id, and the model advertises no levels.
    const profile = parse({ effort_levels: ['low', 'medium', 'high', 'max'], default_effort: 'high' })
    expect(profile.reasoningEfforts).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: 'max',
    })
  })

  it('pins every level the router did not accept as unsupported', () => {
    const profile = parse({ effort_levels: ['high'] })
    // A level left absent would read as supported on pi-ai's five base levels.
    expect(profile.reasoningEfforts).toEqual({
      off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null,
    })
  })

  it('accepts the camelCase spelling the router may use', () => {
    expect(parse({ effortLevels: ['high', 'max'] }).reasoningEfforts).toMatchObject({ high: 'high', max: 'max' })
  })

  it('matches a level whatever its case or surrounding space', () => {
    expect(parse({ effort_levels: [' HIGH ', 'Max'] }).reasoningEfforts).toMatchObject({ high: 'high', max: 'max' })
  })

  it('drops a level the adapter cannot spell rather than guessing a value', () => {
    const profile = parse({ effort_levels: ['turbo', 'high'] })
    expect(profile.reasoningEfforts).toMatchObject({ high: 'high' })
    expect(profile.reasoningEfforts).not.toHaveProperty('turbo')
  })

  it('leaves the field absent when the router names no level', () => {
    // Absent keeps the installed catalog's capability; an empty dict would be
    // refused by the adapter as a model offering nothing.
    expect(parse(true).reasoningEfforts).toBeUndefined()
    expect(parse(undefined).reasoningEfforts).toBeUndefined()
    expect(parse({ effort_levels: [] }).reasoningEfforts).toBeUndefined()
    expect(parse({ effort_levels: ['turbo'] }).reasoningEfforts).toBeUndefined()
  })

  it('keeps the plain capability flag for a non-reasoning model', () => {
    expect(parse(undefined).reasoning).toBe(false)
    expect(parse(true).reasoning).toBe(true)
  })
})
