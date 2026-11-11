/**
 * The workspace domain declaration: record schema and the `defineDomain` spec
 * the registry opens. The zod schema validates the shipped format at the
 * durability boundary and is the direct source of a future RPC wire projection.
 * @module @deepseek-ai/dsh-workspace/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from './types.ts'

/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = z.string().transform(value => value as WorkspaceId)

const sessionId = z.string().transform(value => brandString<SessionId>(value))

/**
 * Durable shape of one workspace record. `path` is the `fs.realpath` canon
 * stamped at create; `sessionIds` is the ordered ownership account (array
 * order is display order); timestamps are ISO-8601 strings.
 */
export const workspaceRecord = z.object({
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionId),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored workspace record, inferred from {@link workspaceRecord}. */
export type WorkspaceRecord = z.infer<typeof workspaceRecord>

/**
 * One Session's explicit project assignment: the Workspace that owns it and
 * the canonical project directory it works in. The assignment outranks the
 * immutable Session header cwd for membership, execution, and file access, and
 * it is the durable record of a Session moved between Workspaces.
 */
export const sessionProjectRecord = z.object({
  /** Canonical directory of the owning Workspace at assignment time. */
  projectPath: z.string(),
  /** ISO-8601 instant the assignment was written. */
  assignedAt: z.string(),
})

/** One stored Session project assignment, inferred from {@link sessionProjectRecord}. */
export type SessionProjectRecord = z.infer<typeof sessionProjectRecord>

/**
 * Recoverable multi-write mutation marker. The marker is persisted before the
 * record/order or assignment/accounting pair can diverge, so startup can
 * distinguish an interrupted registry operation from unexplained medium
 * corruption. `move` names the destination Workspace and the Session whose
 * assignment and accounting it completes.
 */
const workspacePendingMutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), workspaceId }),
  z.object({ operation: z.literal('delete'), workspaceId }),
  z.object({ operation: z.literal('move'), sessionId, workspaceId }),
])

/**
 * Durable registry state. `initialized` distinguishes a valid empty registry
 * from one that still needs the header-only history bootstrap;
 * `workspaceIds` is the authoritative display order. `archivedSessionIds` is
 * the registry-global archive set layered over workspace accounting: an
 * archived session keeps its `sessionIds` slot (unarchiving must restore the
 * position), so the set never participates in the one-owner accounting
 * invariant. `pinnedSessionIds` is the registry-global pin set in pin order
 * (most recently pinned first); pinning and archival are mutually
 * exclusive, so archiving drops the session's pin. Both session sets are
 * defaulted so records written before the fields parse unchanged.
 */
export const workspaceDomainState = z.object({
  initialized: z.boolean(),
  /** First-use Workspace identity, retained after its registration is deleted. */
  defaultWorkspaceId: workspaceId.optional(),
  workspaceIds: z.array(workspaceId),
  archivedSessionIds: z.array(sessionId).default([]),
  pinnedSessionIds: z.array(sessionId).default([]),
  pendingMutation: workspacePendingMutation.optional(),
})

/** Durable registry state inferred from {@link workspaceDomainState}. */
export type WorkspaceDomainState = z.infer<typeof workspaceDomainState>

/**
 * The workspace domain spec: a `workspaces` table keyed by
 * {@link WorkspaceId}, a `session_projects` table keyed by Session id holding
 * the explicit project assignment of every moved Session, plus the
 * bootstrap/order singleton. The registry opens this through
 * `ctx.storage.domain`; the spec object is the single source of the domain's
 * identity, version, and schemas. Version 3 adds `session_projects`; version 2
 * units parse unchanged because the table simply starts empty and the
 * assignment is optional by construction.
 */
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 3,
  compatibleVersions: [2],
  global: {
    schema: workspaceDomainState,
    initial: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
  },
  tables: {
    workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord),
    session_projects: domainTable<SessionId, SessionProjectRecord>(sessionProjectRecord),
  },
})
