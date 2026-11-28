/** Startup documents cannot depend on an asset request during origin handoff. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../../../', import.meta.url)
test('each startup phase embeds the same official Boo image', async () => {
  const mascot = await readFile(new URL('packages/client/ui-verboo/src/client/assets/verboo-mascot.png', root))
  for (const name of [
    'apps/desktop/tauri/ui/index.html',
    'apps/web/public/desktop-startup.html',
    'packages/client/web/src/boot-page.module.css',
    'packages/client/ui-verboo/src/client/startup-mascot.ts',
  ]) {
    const source = await readFile(new URL(name, root), 'utf8')
    const match = source.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)
    assert.ok(match, `${name} embeds Boo`)
    assert.deepEqual(Buffer.from(match[1], 'base64'), mascot, `${name} uses the official mark`)
  }
})
