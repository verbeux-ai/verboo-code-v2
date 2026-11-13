/**
 * Model listing translation.
 *
 * The router advertises the reasoning levels it accepts. The selector's effort
 * pane renders only for a model that declares levels, so a listing that loses
 * them hides the control entirely on an account route.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
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
    expect(profile.reasoningEfforts).toEqual({ low: 'low', medium: 'medium', high: 'high', max: 'max' })
  })

  it('omits every level the router did not accept', () => {
    const profile = parse({ effort_levels: ['high'] })
    // The adapter refuses a null wire value for any level but `off`, and one
    // refusal fails the whole provider group. Absence marks unsupported.
    expect(profile.reasoningEfforts).toEqual({ high: 'high' })
  })

  it('accepts the camelCase spelling the router may use', () => {
    expect(parse({ effortLevels: ['high', 'max'] }).reasoningEfforts).toMatchObject({ high: 'high', max: 'max' })
  })

  it('matches a level whatever its case or surrounding space', () => {
    expect(parse({ effort_levels: [' HIGH ', 'Max'] }).reasoningEfforts).toMatchObject({ high: 'high', max: 'max' })
  })

  it('drops a level the adapter cannot spell rather than guessing a value', () => {
    const profile = parse({ effort_levels: ['turbo', 'high'] })
    expect(profile.reasoningEfforts).toEqual({ high: 'high' })
  })

  it('leaves the field absent when the router names no level', () => {
    // Absent keeps the installed catalog's capability; an empty dict would be
    // refused by the adapter as a model offering nothing.
    expect(parse(true).reasoningEfforts).toBeUndefined()
    expect(parse(undefined).reasoningEfforts).toBeUndefined()
    expect(parse({ effort_levels: [] }).reasoningEfforts).toBeUndefined()
    expect(parse({ effort_levels: ['turbo'] }).reasoningEfforts).toBeUndefined()
    // A declaration offering nothing beyond `off` is refused as well.
    expect(parse({ effort_levels: ['off'] }).reasoningEfforts).toBeUndefined()
  })

  it('declares no levels for a model the router flags without naming them', () => {
    // The adapter derives the capability itself; what the profile must not do is
    // claim a level set the router never listed.
    expect(parse(undefined).reasoningEfforts).toBeUndefined()
    expect(parse(true).reasoningEfforts).toBeUndefined()
  })
})

describe('a malformed capability hint never costs the listing', () => {
  it.each([
    ['null levels', { effort_levels: null }],
    ['numeric levels', { effort_levels: [1, 2] }],
    ['a bare string', { effort_levels: 'low' }],
    ['object levels', { effort_levels: [{ id: 'low' }] }],
    ['a numeric default', { default_effort: 3 }],
    ['an empty object', {}],
    ['a nested object', { reasoning: { effort_levels: ['low'] } }],
  ])('keeps every model when the router sends %s', (_case, reasoning) => {
    // A capability hint is optional decoration. Rejecting the response over it
    // leaves the account with no models at all, which is what a strict schema
    // here caused once already.
    expect(parse(reasoning)).toBeDefined()
  })

  it('still reads the levels from a well-formed object', () => {
    expect(parse({ effort_levels: ['low', 'high'] }).reasoningEfforts).toMatchObject({ low: 'low', high: 'high' })
  })
})

describe('a parsed listing survives the pi-ai adapter', () => {
  /**
   * Resolve one parsed profile through the real adapter.
   * @param reasoning - the router's reasoning field.
   * @returns the level ids the adapter serves, or the refusal it raised.
   */
  async function servedLevels(reasoning: unknown): Promise<readonly string[] | string> {
    const profile = parse(reasoning)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        account: {
          apiKeyEnv: 'ACCOUNT_TEST_KEY',
          api: 'openai-completions',
          baseURL: 'https://account.test/v1',
          models: [profile],
        },
      },
    })
    try {
      const info = await ctx.llm.resolveModelInfo('account', profile.id)
      return (info.reasoning?.efforts ?? []).map(effort => effort.id)
    } catch (error) {
      return (error as Error).message
    }
  }

  it('serves exactly the levels the router named', async () => {
    await expect(servedLevels({ effort_levels: ['low', 'medium', 'high', 'max'], default_effort: 'high' }))
      .resolves.toEqual(['low', 'medium', 'high', 'max'])
  })

  it('never pins an unoffered level to an empty wire value', async () => {
    // The adapter refuses a null wire value for every level but `off`, and one
    // refusal makes the whole provider group a failure, so the account loses
    // every model. Absence is how a level is marked unsupported.
    const served = await servedLevels({ effort_levels: ['low', 'high'] })
    expect(served).toEqual(['low', 'high'])
  })

  it('keeps a model whose router advertises only off', async () => {
    // A declaration with no thinking level is refused too, so this must fall
    // back to the installed capability rather than declare an unusable set.
    await expect(servedLevels({ effort_levels: ['off'] })).resolves.toEqual([])
  })

  it('keeps a model whose router named no level at all', async () => {
    await expect(servedLevels(true)).resolves.toEqual([])
  })
}, 30_000)
