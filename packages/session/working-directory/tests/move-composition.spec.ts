/**
 * REAL-composition proof for the project-to-directory bridge: the shipped
 * Session, projection, filesystem, tool, Agent, agent-loop, Workspace, and
 * working-directory rows boot through the vendored Loader, and creating an
 * Agent for a conversation that was moved makes the assigned project its
 * effective directory.
 *
 * Only the model adapter and the session-persistence peer — the
 * nondeterministic and durable boundaries — are test providers.
 */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * The durable-session peer: this scenario only lists one stored header and
 * accepts the creation handle the loop asks for; it never opens a log body.
 * @param stored - the header the medium holds, as an offline conversation would.
 * @returns the peer plugin, declaring the storage hub as its one dependency.
 */
function testPeers(stored: SessionHeader) {
  return {
    name: 'test-peers',
    inject: ['storage'],
    apply(ctx: Context): void {
      ctx.storage.backend.register('memory', new MemoryStorageBackend())
      const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
      ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      ctx.provide('sessionPersistence', {
        list: () => Promise.resolve([{ header: stored, revision: 'rev-1' }]),
        stat: () => Promise.resolve(undefined),
        remove: () => Promise.resolve(),
        open: () => { throw new Error('event bodies must not be opened') },
        create: async () => ({ append: async () => {} }),
      })
    },
  }
}

/**
 * Boot the shipped rows through the Loader over one isolated root.
 * @param root - directory owning the config and the projects.
 * @param origin - project the stored header names.
 * @returns the loaded context, with the mock model adapter registered.
 */
async function bootComposition(root: string, origin: string): Promise<Context> {
  await writeFile(join(root, 'cordis.yml'), [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@test/llm'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@test/peers'",
    "- name: '@deepseek-ai/dsh-workspace'",
    "- name: '@deepseek-ai/dsh-working-directory'",
    '',
  ].join('\n'))

  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@test/llm', LlmRuntime],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@test/peers', testPeers({
      version: SESSION_FORMAT_VERSION, id: SessionId('moved-conversation'), createdAt: 1, isSeeded: false, cwd: origin,
    })],
    ['@deepseek-ai/dsh-workspace', WorkspaceRegistry],
    ['@deepseek-ai/dsh-working-directory', WorkingDirectory],
  ])
  const source: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
  ctx.loader.internal = source
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(root, 'cordis.yml')).href },
  })
  await ctx.loader.await()
  // Every declared row activated; none is silently pending.
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)).toEqual([])
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  return ctx
}

describe('moved conversation real Loader composition', () => {
  it('starts a resumed Agent in the project it was moved to', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-loader-')))
    const origin = join(root, 'origin')
    const destination = join(root, 'destination')
    await mkdir(origin)
    await mkdir(destination)
    context = await bootComposition(root, origin)

    // The stored header names the project the conversation was created in, so
    // the registry bootstrap groups it there from headers alone.
    const sessionId = SessionId('moved-conversation')
    const originWorkspace = context.workspaceRegistry.list()
      .find(workspace => workspace.path === origin)
    if (originWorkspace === undefined) throw new Error('bootstrap did not group the stored Session')
    expect(originWorkspace.sessionIds).toEqual([sessionId])
    const destinationWorkspace = await context.workspaceRegistry.create(destination)
    await context.workspaceRegistry.moveSession(sessionId, destinationWorkspace.id)

    // Starting the conversation later mints its live header with the original
    // project; the bridge applies the durable assignment on top of it.
    const agent = await context.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: origin })
    expect(agent.session.header.cwd).toBe(origin)
    // The conversation works in the destination project from its first request
    // on, and the change is logged as the model-visible directory transition.
    expect(context.workingDirectory.get(agent.session)).toBe(destination)
    expect(agent.session.snapshotEvents()).toContainEqual(expect.objectContaining({
      type: 'working-directory/change', data: { cwd: destination },
    }))
    expect(context.sessionProjections.snapshot(agent.session).values.workingDirectory).toBe(destination)
    // The registry answers every project consumer through the same authority.
    expect(context.workspaceRegistry.projectPathOf(agent.session.id)).toBe(destination)
  })

  it('still starts the Agent when the assigned project disappeared, leaving the report to prompt assembly', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-move-loader-gone-')))
    const origin = join(root, 'origin')
    const destination = join(root, 'destination')
    await mkdir(origin)
    await mkdir(destination)
    context = await bootComposition(root, origin)
    const sessionId = SessionId('moved-conversation')
    const destinationWorkspace = await context.workspaceRegistry.create(destination)
    await context.workspaceRegistry.moveSession(sessionId, destinationWorkspace.id)
    // The destination project goes away while the conversation is stored.
    // Creation must still succeed: an unopenable conversation is worse than a
    // stale directory, and assembly is where a caller can act on the problem.
    await rm(destination, { recursive: true })
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    try {
      const agent = await context.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: origin })
      // The creation succeeded and kept the directory it had; the assignment
      // is not applied and the failure is a diagnostic, not a broken open.
      expect(context.workingDirectory.get(agent.session)).toBe(origin)
      expect(agent.session.snapshotEvents().some(event => event.type === 'working-directory/change')).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not apply project'))
      // A caller that wants the project reports it through the ordinary paths.
      await expect(context.workingDirectory.ensure(agent)).resolves.toBe(origin)
    } finally {
      warn.mockRestore()
    }
  })
})
