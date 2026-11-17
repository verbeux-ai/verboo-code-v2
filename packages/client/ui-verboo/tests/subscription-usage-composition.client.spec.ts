/**
 * The reading crosses two faces: the Host route serves it and the Client reads
 * it. Both blockers this file guards against were invisible to component tests,
 * because each end was exercised alone.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SubscriptionUsage } from '../src/client/subscription-usage-resource.ts'

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('subscription usage composition', () => {
  it('uses the generated subscription reading without a second namespace declaration', () => {
    expectTypeOf<Awaited<ReturnType<ClientRemote['llmOpenaiAccount']['usage']>>>()
      .toEqualTypeOf<RemoteResult<SubscriptionUsage | undefined>>()
  })

  it('addresses that namespace at the call site', () => {
    const index = read('../src/client/index.ts')
    expect(index).toContain('ctx.remote.llmOpenaiAccount.usage(')
    expect(index).not.toContain('ctx.remote.verboo.getSubscriptionUsage')
  })

  it('mounts both packages from the product roster', () => {
    // A `- id:` row with no `name` patches nothing: the plugin reaches a package
    // only through an insert row that names it.
    const roster = read('../../../bundle/verboo-app/cordis.patch.yml')
    for (const pkg of ['@deepseek-ai/dsh-openai-account', '@deepseek-ai/dsh-llm-openai-account']) {
      expect(roster).toContain(`name: '${pkg}'`)
    }
    // And the product bundle must depend on them, or packaging cannot resolve.
    const manifest = read('../../../bundle/verboo-app/package.json')
    expect(manifest).toContain('"@deepseek-ai/dsh-openai-account"')
    expect(manifest).toContain('"@deepseek-ai/dsh-llm-openai-account"')
  })
})
