# Agent Note: Moving a conversation between projects

Status: implemented

English | [中文](2026-11-10-project-assignment-and-session-moves.zh.md)

## Problem

A conversation belonged to whatever directory it was created in, and nothing could change that. The link was not a field anyone owned: it was derived from the immutable `SessionHeader.cwd` and materialized as the workspace record's ordered `sessionIds`, so `attachSession` validated `realpathNormalize(header.cwd) === record.path` and rejected everything else. The registry indexed membership by header, and one session accounted by two workspaces was treated as medium corruption that failed the boot.

That is the right invariant and the wrong product limitation. A user who starts a conversation in the wrong folder, or who wants to continue an old conversation against a different checkout, has to fork or start over. The directory itself already had a durable, model-visible change path — `working-directory/change` and `ctx.workingDirectory` — and its own documentation states that "the immutable Session header retains the original project". The architecture therefore already separates "original project" from "effective directory"; what it lacked was a place to say that the *project* changed.

The code had already drifted around that gap. `@` file mentions and the bash shells used the effective directory projection, while `sandbox-policy` and `workspace-files` used the raw `header.cwd`. A conversation that changed directory therefore had a sandbox writable root and a file-preview root that disagreed with what its tools actually touched. Any move had to make all of them agree, not add a fourth opinion.

## Decision

The header stays immutable and the transcript never moves. What changes is a durable project assignment owned by the workspace domain, which outranks the header everywhere a project is resolved.

**The domain gains one table and one marker arm.** `workspace` moves to version 3 with a `session_projects` table keyed by Session id holding `{ projectPath, assignedAt }`, and the recoverable `pendingMutation` union gains `{ operation: 'move', sessionId, workspaceId }`. Version 2 media parse unchanged: the table is simply absent, and an assignment is optional by construction. No new column was added to the workspace record, because ownership must not be expressible twice.

**One resolution function decides.** `WorkspaceRegistry.projectPathOf(sessionId)` answers "which project does this conversation belong to": the assignment when one exists, otherwise the canonical cwd of the indexed header. `candidateMatches`, `attachSession`, the bootstrap grouping, and `validateStoredState` all route through it. The bootstrap stays header-only and cheap — it consults assignments already loaded with the domain, never a log replay — and an assignment needs no filesystem check because it was validated when it was written.

**`moveSession` writes assignment, then accounting, under the marker.** It refuses running work through the same `workspace/session-activity` waterfall archival uses, with `WorkspaceActiveSessionError` and the `move` verb, and refuses a destination that is unknown or whose directory is not currently a directory (`WorkspaceMoveTargetInvalidError`). The accepted path writes the assignment first — it is what makes membership resolve to the destination — then detaches from every other account, then prepends to the destination, then clears the marker. A crash between any two of those is completed at the next startup or registry operation: `recoverPendingMutation` completes a marked move rather than rolling it back, because the assignment is the only writer of project membership and finishing it is what guarantees exactly one owner.

**The assignment reaches execution through `agent/created`.** `dsh-working-directory` listens for the serial `agent/created` event, compares `projectPathOf` with the recorded directory, and commits a `working-directory/change` when they differ; `ensure` now restores to the project instead of to the header. That commit is the same model-visible transition a user `cd` produces, so the move needs no new session event, no new prompt text, and no header rewrite. The bridge lives in the package that already owns the effective directory and already depends on the projection, rather than in the generic dispatch layer.

**Project consumers read the same authority.** `sandbox-policy.resolve` and the `workspace-files` scope lookup read `ctx.get('workspaceRegistry')?.projectPathOf(id)` and fall back to `header.cwd` only when no registry is mounted. The service is read optionally, not injected: both packages must keep working in compositions that mount no workspace registry (agent-less calls, SDK profiles), and a mandatory injection would leave them pending forever there. This is what closes the pre-existing divergence between `@`/shells and sandbox/file access.

**One Remote verb, one Client command, one menu entry.** `workspace/moveSession` takes `{ sessionId, workspaceId, stopActivity? }` and answers with the resulting ownership plus the destination row, so the Client reflects the move immediately without waiting for the follow frame. The three refusals are `workspace/session-active`, `workspace/move-invalid`, and `session/not-found`. `ClientWorkspaceModel.moveSession` merges only the destination row, because the origin row's new account arrives on the stream. The UI raises a request from a `ctx.contextMenus` entry at order 400 (between Fork and Copy ID) and the `shell.overlay` dialog owns the Host call: it lists every registered project except the current owner, confirms, and reports a `workspace/session-active` refusal in place, naming what still runs.

## Alternatives considered

**Rewrite `SessionHeader.cwd`.** It would need no new table and no new resolution function, but the header is the one immutable fact the whole persistence layer, the format migrations, and the workspace index build on. Rewriting it turns a product action into a format change, makes a session's origin unrecoverable, and would have to reach every generation of a stored log — and the working-directory module's documented contract already promises the header keeps the original project.

**Move the transcript files under the destination project's storage directory.** It buys nothing the assignment does not: the transcript is addressed by session id, its location is not user-visible, and relocating committed generations is exactly the operation the released-format policy forbids.

**Store the project on the workspace record (`record.sessionId → path`) or on a new session row.** Either would create a second place that decides membership. The assignment table is keyed by session, which is the identity membership is about; keeping it out of the workspace record means a record write cannot silently re-home a conversation.

**Make the injection mandatory in `sandbox-policy` and `workspace-files`.** It reads as the stricter contract, but it would make both packages unloadable in every composition that mounts no registry, including the SDK and headless profiles, for a fact they can fall back on.

**Append a new session event for the move.** The model-visible effect already has an event — `working-directory/change` — and the requirement is that the model understand which directory it works in, not that it learn a product action happened. A second event would have to be read by every projection for no additional fact.

**Do the move only in the Client.** Reordering the sidebar would meet the letter of "move to project" and none of the intent: bash, the sandbox writable root, and `@` references would keep resolving to the old project, which is precisely the divergence this change removes.

## Consequences

A moved conversation keeps its transcript, its history, and its original header directory, and works in the destination project on its next request. Anything already running keeps its old directory — existing terminals and shells are the documented behavior of a directory change, not a new exception — which is why the move refuses running work instead of pretending to relocate it.

The assignment is now the second thing that can be wrong about membership. `validateStoredState` therefore also fails loud when an assignment's `projectPath` disagrees with the record accounting the session, so a divergent write surfaces at boot rather than as a session that appears in one project and works in another.

Two packages now depend on the workspace package for a type-only merge of `ctx.workspaceRegistry`; the load order does not change, because the read is optional.

`workspace-files` keeps answering with the project root, so a preview opened after a move lists the destination project. A path the user is still looking at under the old project stays readable by absolute path, which is the service's documented read authority rather than a containment rule.

## Testing

`packages/workspace/workspace/tests/workspace.spec.ts` covers the happy move, the running-work refusal writing nothing, the unknown and missing-directory destinations, the idempotent repeat, restart preservation, both interrupted-marker shapes (crash before the assignment, crash after it), the duplicate-account and divergent-assignment failures, attach after a move, an unowned session, assignment cleanup on deletion, and a failed write leaving no half state. `packages/session/working-directory/tests/move-composition.spec.ts` is the real-composition proof: it boots the shipped rows through the Loader, moves a conversation, creates its Agent, and asserts the effective directory, the logged `working-directory/change`, and the projection value. `packages/api/workspace-controller` covers the three Remote codes, `stopActivity`, and the client model's echo; `packages/client/ui-workspace` covers the menu entry, its access gate, the dialog's destination list and refusal rendering, and the moved notice. `packages/sandbox/sandbox-policy` and `packages/api/workspace-files` each prove an assignment outranks the header.

## Related

- [Working directory](../../../../docs/subsystems/working-directory.md) — the effective-directory owner this bridge extends.
- [Workspaces](../../../../docs/subsystems/workspace.md) — the domain, registry, and Remote surface.
- [Archiving a Session with running work](../feature/2026-09-21-archive-stops-running-session-work.md) — the activity and stop events a move reuses unchanged.
