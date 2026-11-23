/**
 * Model listing translation.
 *
 * The router advertises the reasoning levels it accepts. The selector's effort
 * pane renders only for a model that declares levels, so a listing that loses
 * them hides the control entirely on an account route.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { DeepSeekAccount, PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountSessionId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import * as VerbooModels from '../src/models.ts'
import type { Deployment } from '../src/config.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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
  return VerbooModels.parseModels({
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

async function catalogFixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let session: PlatformSession = {
    origin: 'https://accounts.example.test', userId: null, sessionId: 'first-session' as AccountSessionId,
    token: 'first-fixture-token',
  }
  const account = {
    resolveToken: vi.fn(async () => session.token),
    getPlatformSession: vi.fn(async () => session),
  }
  ctx.provide('deepseekAccount', account as unknown as DeepSeekAccount)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin({ name: VerbooModels.name, inject: VerbooModels.inject, apply: VerbooModels.apply }, {
    routerBaseURL: 'https://router.example.test/v1', apiOrigin: session.origin,
  })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({
    data: [{ id: 'current-group/current-model' }],
  }))
  vi.stubGlobal('fetch', fetch)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return {
    ctx, account, fetch,
    list: () => ctx.llm.listModels('deepseek-account'),
    setSession(sessionId: string, token: string) {
      session = { ...session, sessionId: sessionId as AccountSessionId, token }
    },
  }
}

it('never lists the previous account’s models with a stale token after a switch', async () => {
  const fixture = await catalogFixture()
  const started = Promise.withResolvers<undefined>()
  const token = Promise.withResolvers<string>()
  fixture.account.resolveToken.mockImplementationOnce(() => { started.resolve(undefined); return token.promise })
  const listing = fixture.list()
  await started.promise
  fixture.setSession('second-session', 'second-fixture-token')
  token.resolve('first-fixture-token')
  expect(await listing).toEqual([])
  expect(fixture.fetch).not.toHaveBeenCalled()
  expect((await fixture.list()).map(model => model.id)).toEqual(['current-group/current-model'])
  const [url, init] = fixture.fetch.mock.calls[0]!
  expect(url).toBe('https://router.example.test/v1/models')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer second-fixture-token')
})

it('drops a model response from a retired credential generation', async () => {
  const fixture = await catalogFixture()
  const started = Promise.withResolvers<AbortSignal>()
  const response = Promise.withResolvers<Response>()
  fixture.fetch.mockImplementationOnce((_url, init) => { started.resolve(init!.signal!); return response.promise })
  const listing = fixture.list()
  const signal = await started.promise
  fixture.setSession('first-session', 'refreshed-fixture-token')
  fixture.ctx.emit('credentials/record-updated', 'verboo-account/default' as CredentialKey)
  expect(signal.aborted).toBe(true)
  const currentListing = fixture.list()
  try {
    await vi.waitFor(() => { expect(fixture.fetch).toHaveBeenCalledTimes(2) })
    expect((await currentListing).map(model => model.id)).toEqual(['current-group/current-model'])
  } finally {
    response.resolve(Response.json({ data: [{ id: 'retired-group/old-model' }] }))
  }
  expect(await listing).toEqual([])
  expect((await fixture.list()).map(model => model.id)).toEqual(['current-group/current-model'])
  expect(fixture.fetch).toHaveBeenCalledTimes(2)
})
