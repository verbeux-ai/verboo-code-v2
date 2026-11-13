/**
 * The reading crosses two faces: the Host route serves it and the Client reads
 * it. Both blockers this file guards against were invisible to component tests,
 * because each end was exercised alone.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('subscription usage composition', () => {
  it('reads the namespace the route actually serves', () => {
    // The route's generated face names one namespace; the Client's declaration
    // must name the same one, or the read resolves against nothing.
    const generated = read('../../../llm/llm-openai-account/lib/typert.remote-client.d.ts')
    const client = read('../src/client/subscription-usage-resource.ts')
    const served = /'llmOpenaiAccount': (TypertRemoteNamespace\$[0-9a-f]+)/.exec(generated)
    expect(served).not.toBeNull()
    expect(client).toContain(`interface ${served![1]}`)
    expect(client).toContain("'llmOpenaiAccount':")
  })

  it('names the method the route exposes', () => {
    const generated = read('../../../llm/llm-openai-account/lib/typert.remote-client.d.ts')
    const client = read('../src/client/subscription-usage-resource.ts')
    // `getSubscriptionUsage` was a name no Host ever served.
    expect(generated).toContain('usage: (signal?: AbortSignal)')
    expect(client).toContain('usage: (signal?: AbortSignal)')
    expect(client).not.toContain('getSubscriptionUsage')
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
