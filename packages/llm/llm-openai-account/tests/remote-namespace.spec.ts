/** The Remote endpoint the Host serves, read the way the Gateway discovers it. */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it } from 'vitest'
import OpenAiAccountRoute from '../src/index.ts'
import type { OpenAiAccountService } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount the runtime and this route with a stored session. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const stored: OpenAiAccountService = {
    accessToken: async () => undefined,
    status: async () => ({ signedIn: false }),
  }
  ctx.provide('openaiAccount', stored)
  await ctx.plugin(OpenAiAccountRoute)
  return ctx
}

it('serves the usage reading at the endpoint the Client addresses', async () => {
  const ctx = await harness()
  const service = ctx.get('llmOpenaiAccount')
  // The route is provided by the plugin just mounted; a missing service means
  // the registration itself failed, which this test must not read past.
  if (service === undefined) throw new Error('the route did not register its service')
  const binding = Reflect.get(service, 'typertRemote')
  expect(binding).toMatchObject({ serviceKey: 'llmOpenaiAccount', namespace: 'llmOpenaiAccount' })
  const markers = remoteMethods(service)
  expect(markers.map(marker => `${binding.namespace}/${marker.exportName ?? marker.method}`))
    // Two surfaces: the reading the composer shows, and the discovery a
    // sign-in starts so the menu offers only what the account can use.
    .toEqual(['llmOpenaiAccount/discoverModels', 'llmOpenaiAccount/usage'])
})

it('never throws from the Remote method, so the carrier reports no failure', async () => {
  const ctx = await harness()
  const service = ctx.get('llmOpenaiAccount')
  if (service === undefined) throw new Error('the route did not register its service')
  await expect(service.usage(new AbortController().signal)).resolves.toBeUndefined()
})
