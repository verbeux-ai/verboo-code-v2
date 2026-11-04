import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDiskImage } from '../create-dmg.mjs'

test('creates a verified native image without mounting it and preserves existing installer bytes', { skip: process.platform !== 'darwin', timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'verboo-dmg-test-'))
  let operation
  t.after(async () => {
    await Promise.allSettled(operation ? [operation] : [])
    await rm(root, { recursive: true, force: true })
  })
  const application = join(root, 'Verboo Fixture.app')
  await mkdir(join(application, 'Contents'), { recursive: true })
  await writeFile(join(application, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Verboo Fixture</string></dict></plist>')
  const destination = join(root, 'output/fixture.dmg')
  operation = createDiskImage({ application, destination, name: 'Verboo Fixture', signal: t.signal })
  assert.equal(await operation, destination)
  const bytes = await readFile(destination)
  assert.ok(bytes.length > 512)
  await assert.rejects(createDiskImage({ application, destination, name: 'Verboo Fixture', signal: t.signal }), { code: 'EEXIST' })
  assert.deepEqual(await readFile(destination), bytes)
  await assert.rejects(createDiskImage({ application, destination: join(root, 'output/cancelled.dmg'), name: 'Verboo Fixture', signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.deepEqual(await readdir(join(root, 'output')), ['fixture.dmg'])
})
