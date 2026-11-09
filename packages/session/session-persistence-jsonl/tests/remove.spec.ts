/**
 * Backend-owned removal semantics: one call deletes every artifact the JSONL
 * backend holds for a session, including every immutable generation and any
 * residue an earlier layout wrote into the shared project directory. These
 * cases stay here rather than in the shared contract because the layout is
 * this backend's own.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { encodeSegment, generationLogPath, logSuffix, projectDir, sessionDir } from '../src/format.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const roots: string[] = []
const contexts: Context[] = []

async function mount(compression: 'none' | 'zstd' = 'none'): Promise<{ persistence: SessionPersistence; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-remove-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return { persistence: ctx.sessionPersistence, root }
}

/** Write a whole session log through its write handle, so the artifact is durable. */
async function writeLog(persistence: SessionPersistence, header: SessionHeader): Promise<void> {
  const handle = await persistence.create(header)
  try {
    await handle.append(oneTurnLog())
  } finally {
    await handle.close()
  }
}

async function listIds(persistence: SessionPersistence): Promise<string[]> {
  return (await persistence.list()).map(snapshot => String(snapshot.header.id)).sort()
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('JsonlSessionPersistence.remove', () => {
  it('deletes the session and every generation, leaving no residue in the project directory', async () => {
    const { persistence, root } = await mount()
    const header = meta('remove-me', '/projects/alpha')
    await writeLog(persistence, header)
    const kept = meta('keep-me', '/projects/alpha')
    await writeLog(persistence, kept)
    expect(await listIds(persistence)).toEqual(['keep-me', 'remove-me'])

    const dir = sessionDir(root, header.cwd, header.id)
    // A historical generation and a sibling artifact prove removal is not just
    // "delete the current file": the whole session directory goes.
    await writeFile(generationLogPath(root, header.cwd, header.id, 1, 'none'), '{"type":"session"}\n')
    await writeFile(join(dir, 'attachment.bin'), 'binary')
    expect((await readdir(dir)).length).toBeGreaterThan(1)

    await persistence.remove(header.id)

    // Nothing of this session survives anywhere under the project directory.
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    const projectEntries = await readdir(projectDir(root, header.cwd))
    expect(projectEntries).toEqual([encodeSegment(kept.id)])
    // The project directory itself belongs to the other session and stays.
    expect((await stat(projectDir(root, header.cwd))).isDirectory()).toBe(true)

    expect(await listIds(persistence)).toEqual(['keep-me'])
    await expect(persistence.stat(header.id)).resolves.toBeUndefined()
    await expect(persistence.open(header.id, 'read')).rejects.toMatchObject({ name: 'SessionPersistenceNotFoundError' })
    expect(await listIds(persistence)).toEqual(['keep-me'])
  })

  it('removes a zstd session and the legacy flat-file spellings beside it', async () => {
    const { persistence, root } = await mount('zstd')
    const header = meta('compressed', '/projects/beta')
    await writeLog(persistence, header)
    const project = projectDir(root, header.cwd)
    // An artifact written by the retired flat-file layout, under both suffixes.
    await writeFile(join(project, encodeSegment(header.id) + logSuffix('none')), 'old\n')
    await writeFile(join(project, encodeSegment(header.id) + logSuffix('zstd')), 'old\n')

    await persistence.remove(header.id)

    expect(await readdir(project)).toEqual([])
    expect(await listIds(persistence)).toEqual([])
  })

  it('treats an unknown id as already removed and writes nothing', async () => {
    const { persistence, root } = await mount()
    const header = meta('present', '/projects/gamma')
    await writeLog(persistence, header)
    const before = await readdir(projectDir(root, header.cwd))

    // A repeated or racing removal must not fail a caller whose intent already
    // holds, and must not touch another session's artifacts.
    await expect(persistence.remove(SessionId('never-stored'))).resolves.toBeUndefined()
    expect(await readdir(projectDir(root, header.cwd))).toEqual(before)
    expect(await listIds(persistence)).toEqual(['present'])
  })

  it('removes a created session that never materialized, so it stops being listed', async () => {
    const { persistence } = await mount()
    const header = meta('unmaterialized', '/projects/delta')
    const handle = await persistence.create(header)
    // Never appended and never flushed: visible in this process only.
    expect(await listIds(persistence)).toEqual(['unmaterialized'])

    await persistence.remove(header.id)

    expect(await listIds(persistence)).toEqual([])
    await expect(persistence.open(header.id, 'read')).rejects.toMatchObject({ name: 'SessionPersistenceNotFoundError' })
    await handle.close()
  })

  it('finds and removes a session whose header cannot be read, by the directory that holds its id', async () => {
    const { persistence, root } = await mount()
    const header = meta('unreadable', '/projects/epsilon')
    await writeLog(persistence, header)
    // Corrupt the only generation's header line beyond any structural reading.
    await writeFile(generationLogPath(root, header.cwd, header.id, header.version, 'none'), 'not json\n')
    const before = await listIds(persistence)
    // A corrupt header already keeps the artifact out of the listing, yet the
    // id is still deletable, which is what a user's delete click needs.
    expect(before).toEqual([])

    await persistence.remove(header.id)
    await expect(stat(sessionDir(root, header.cwd, header.id))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects when the filesystem refuses the deletion and keeps the session listed', async () => {
    const { persistence, root } = await mount()
    const header = meta('stubborn', '/projects/zeta')
    await writeLog(persistence, header)
    const dir = sessionDir(root, header.cwd, header.id)
    // A read-only directory makes rm fail with EACCES, the same shape as a
    // permission fault on a shared or locked volume.
    await chmod(dir, 0o500)
    try {
      await expect(persistence.remove(header.id)).rejects.toMatchObject({ code: 'EACCES' })
      // The failure is visible as the session still being there: no silent
      // orphan and no reported success over surviving artifacts.
      await expect(stat(dir)).resolves.toBeDefined()
      expect(await listIds(persistence)).toEqual(['stubborn'])

      // Removing is safe to repeat once the fault clears.
      await chmod(dir, 0o700)
      await persistence.remove(header.id)
      expect(await listIds(persistence)).toEqual([])
      await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await chmod(dir, 0o700).catch(() => {})
    }
  })

  it('honors an already-aborted signal before touching the filesystem', async () => {
    const { persistence, root } = await mount()
    const header = meta('kept-by-abort', '/projects/eta')
    await writeLog(persistence, header)
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))

    await expect(persistence.remove(header.id, { signal: controller.signal })).rejects.toThrow('caller cancelled')
    expect(await listIds(persistence)).toEqual(['kept-by-abort'])
    await expect(stat(sessionDir(root, header.cwd, header.id))).resolves.toBeDefined()
  })

  it('drops a cached parse so a later stat cannot answer from memory', async () => {
    const { persistence, root } = await mount()
    const header = meta('cached', '/projects/theta')
    await writeLog(persistence, header)
    // Reading the session fills the backend's handoff cache.
    const handle = await persistence.open(header.id, 'read')
    await handle.close()
    await expect(persistence.stat(header.id)).resolves.toBeDefined()

    await persistence.remove(header.id)

    // The artifacts are gone and no memoized parse can resurrect them.
    await expect(persistence.stat(header.id)).resolves.toBeUndefined()
    await expect(stat(sessionDir(root, header.cwd, header.id))).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(sessionDir(root, header.cwd, header.id), { recursive: true })
  })
})
