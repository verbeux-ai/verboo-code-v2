/** MCP resource and server-manager ownership across the resolved shipped profile templates. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'

const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const resourcePackage = '@deepseek-ai/dsh-mcp-resources'

describe('shipped MCP resource composition', () => {
  it.each(Object.keys(PROFILE_TEMPLATES))('%s carries one shared resource consumer without a server', (name) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-mcp-'))
    try {
      const profile = loadProfile('dsh', name, installAnchor, home)
      const warnings: string[] = []
      const rows = composeEntries([
        ...profile.layers.map(layer => layer.patches),
        profile.patches,
      ], message => warnings.push(message))

      expect(rows.filter(row => row.name === resourcePackage)).toEqual([
        { id: 'mcp-resources', name: resourcePackage },
      ])
      expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
      expect(warnings).toEqual([])

      const owners = profile.layers.filter((layer) => {
        const manifest = JSON.parse(readFileSync(join(layer.packageDir, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>
        }
        return manifest.dependencies?.[resourcePackage] !== undefined
      })
      expect(owners.map(owner => owner.packageName)).toEqual([
        name === 'sdk-minimal' ? '@deepseek-ai/dsh-sdk-minimal' : '@deepseek-ai/dsh-base',
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.each(Object.keys(PROFILE_TEMPLATES))('%s mounts the server manager exactly when its bundles carry the Web application', (name) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-mcp-'))
    try {
      const profile = loadProfile('dsh', name, installAnchor, home)
      const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
      // The manager is a Web-application feature, not a base one, so a profile
      // mounts it iff one of its bundles is the web app — the product profile
      // includes that bundle, which is why its users get the server manager too.
      const expected = PROFILE_TEMPLATES[name]!.bundles.includes('@deepseek-ai/dsh-web-app')
        ? [{ id: 'mcp-manager', name: '@deepseek-ai/dsh-mcp-manager', inject: ['credentials'] }]
        : []
      expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-manager')).toEqual(expected)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
