/**
 * The product roster mounts every plugin this layer owns.
 *
 * A `- id:` row with no `name` patches a plugin some other layer declared; it
 * does not mount a new one. Both the account and its route were once written
 * that way, which typechecked, passed their own suites, and loaded nothing.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')

/** Package names this layer mounts through an `insert` row. */
const inserted = ((): Set<string> => {
  const roster = read('cordis.patch.yml')
  return new Set([...roster.matchAll(/^\s+name: '([^']+)'$/gm)].map(match => match[1]!))
})()

describe('product roster', () => {
  it('mounts the [OI] account and its route', () => {
    for (const pkg of ['@deepseek-ai/dsh-openai-account', '@deepseek-ai/dsh-llm-openai-account']) {
      expect(inserted).toContain(pkg)
    }
  })

  it('depends on every package it mounts', () => {
    // Packaging resolves a bare plugin name through this manifest, so a mount
    // without a dependency fails at package time, not at review time.
    const manifest = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> }
    const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
    for (const pkg of inserted) {
      // Client and web packages are mounted by other layers; only this layer's
      // own additions are asserted here.
      if (!pkg.startsWith('@deepseek-ai/dsh-llm') && !pkg.startsWith('@deepseek-ai/dsh-openai')) continue
      expect(dependencies).toContain(pkg)
    }
  })
})
