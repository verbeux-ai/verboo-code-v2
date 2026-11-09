# Agent Note: Deleting a stored Session

Status: implemented

English | [中文](2026-11-09-session-deletion.zh.md)

## Problem

Archiving was the only way to put a conversation away, and it deliberately keeps everything: the archive set hides a row while the transcript stays on disk, the workspace account keeps its slot, and unarchive restores the position. A user who wants a conversation gone for good — one holding a mistaken prompt, a leaked credential, or a test they no longer want listed — had no product action at all, and no seam operation either: `SessionPersistence` offered create, open, stat, list, flush, and handles, so nothing in the composition could delete a log. The only recourse was deleting files by hand under the storage root, which leaves the registry accounting orphaned in the opposite direction: an id the medium no longer holds stays in the archive set and in a workspace account until a restart reindexes.

Deletion also cannot be a pure storage operation, because a session can be mid-turn. Removing the log under a running turn lets the turn append into a path that was just deleted, which silently re-materializes a session the user asked to destroy, and leaves whatever subagents, jobs, and reminders still run with nowhere to write.

## Decision

Deletion is a new capability seam path, not a variant of archival, and it is owned by the two packages that already own the two halves of the fact.

**The storage contract gains one destructive method.** `SessionPersistence.remove(id)` deletes every artifact the backend owns for a session and resolves once they are gone. It is defined on the Service Definition with a concrete default that rejects as `SessionRemoveUnsupportedError` rather than an abstract member: a backend that keeps no removable per-session artifact must refuse loudly, never report a deletion it cannot perform, and the shipped test doubles that subclass the service keep compiling without pretending to a capability they lack. `SessionPersistenceRemoveOptions` carries cancellation observed before backend work starts.

**The JSONL backend addresses removal by id alone.** `remove` deletes `<project>/<encoded-id>/` under every project directory — which owns every immutable generation and every side artifact — and then the obsolete flat-file spellings a retired layout wrote beside it. It never removes the shared project directory, and it never reads a header first: a log whose header is corrupt, or newer than this build, must still be deletable, and the root's encoding check must not block a deletion the user asked for. The id is the address, so an id with no artifact resolves without writing (a repeat or a race is a no-op), and a filesystem refusal rejects with the session left visible exactly as it was, which makes the call safe to repeat. Because the in-process state would otherwise answer for artifacts that no longer exist, removal also drops the handoff parse cache for that id, aborts its in-flight migration preparation, and drops its created-but-unmaterialized entry.

**The registry owns the ordering, the accounting, and the running-work rule.** `WorkspaceRegistry.deleteSession(sessionId, { stopActivity })` reuses the two archive-admission events with the order inverted. Without `stopActivity` it asks `workspace/session-activity` once and refuses a non-empty answer with `WorkspaceActiveSessionError` — the same type as archival, now carrying the `delete` verb in its message — before anything is written or deleted. With `stopActivity` it asks `workspace/session-stop` first and only then removes the transcript, so no turn appends to a log that is about to disappear; a rejecting provider is logged, not a reason to keep a transcript the user asked to destroy. After a successful removal it deletes the header index entry, drops the id from the archive and pin sets, and prunes it from every workspace account, then republishes the entity snapshots.

**Failure never leaves a silent orphan.** A backend removal failure propagates before any accounting write, so the row stays visible and the call is safe to repeat. A failure *after* the removal rejects as an `AggregateError` naming the committed deletion; the in-memory projection has already dropped the session, so no surface keeps showing a row whose log is gone, and startup reindexing drops the dangling id. The API maps that state to its own Remote code, `workspace/delete-incomplete`, so a surface can say the conversation is gone and only cleanup is pending instead of reporting a generic failure.

**Unknown ids are already in the requested state.** `deleteSession` resolves for an id the registry does not know, because the requested end state is absence: a repeated click, a lost race with another surface, or a stale row must not fail. This differs from `archiveSession`, which rejects an unknown id because adding to a set is not idempotent in the same direction.

**The action is confirmed, and only the dialog calls the Host.** `ui-workspace` contributes one `ctx.contextMenus` action for the `session` target at order 700, marked `danger: true` (the shared `Menu` primitive renders that as error-colored text and icon) and drawn with the existing `trash-outline` glyph; it raises a `SessionDeleteConfirmRequest` and never calls the Host itself. The `shell.overlay` dialog names the conversation, states that the transcript is deleted and the work stopped first, and that it cannot be undone. Confirming calls `deleteSession(id, { stopActivity: true })`; cancelling settles the request and deletes nothing. `UiWorkspaceService.deleteSession` clears the current selection when it named that session and then refreshes the Session list, so the row disappears through the Host list rather than lingering as a row whose log no longer exists.

## Alternatives considered

**A flag on archive (`archiveSession(id, { purge: true })`).** It would keep one Remote verb and one permission, but it makes a reversible and an irreversible operation share a request shape, a Remote code, and a client callback signature; a mistake in the caller's options silently destroys a transcript. Separate verbs make the destructive choice explicit at every layer, and the UI's confirmation is what makes the pair safe rather than the option name.

**An abstract `remove` on the Service Definition.** Abstractness is the honest signal for a provider obligation, but five test doubles in other packages subclass the service to stand in for a backend; making the member abstract turns a capability gap into a compile break in packages this change does not otherwise touch, and a silently inherited no-op would be worse still. A concrete default that throws `SessionRemoveUnsupportedError` keeps the gap visible at runtime, in the seam's own error vocabulary.

**Deleting from the client by listing, selecting, and removing each generation.** The selection rule (highest canonical generation) is the backend's, and the flat-file spellings, temp links, and future side artifacts are backend-private. A consumer that reproduced them would drift the moment the layout changed, and would have to handle an unreadable header it cannot select a generation from.

**Stopping asynchronously, like archival (`stopActivity` writes first, stops after).** Archival can write first because the archive set is itself the gate that blocks later wakes. Deletion has no such gate: the log is gone, so a wake that the stop induced would re-materialize it. Removal therefore waits for the stop requests to be issued — not for the work to settle — before deleting; the ordering is the whole guarantee.

**Refusing an unknown id, mirroring `archiveSession`.** Symmetry with the sibling verb reads well but gets the semantics backwards: adding an unknown id to a set creates a referent, while removing an unknown id completes the caller's request. Rejecting makes a double click an error and forces every surface to special-case a race it cannot observe.

**Deleting the project directory when its last session goes.** It would look tidy, but the directory is derived from a cwd that other sessions, unowned artifacts, and a user's own files share; a project directory is not storage-owned. Only the session's own directory is deleted.

## Consequences

A deleted conversation cannot be restored by any surface: there is no undo, no archived copy, and no log to reopen, which is why the action sits behind a confirmation and is marked destructive. The Remote code `workspace/delete-incomplete` is an outcome no user can fix themselves; it reports that the conversation is gone and only registry cleanup is pending, and startup reindexing completes it. Removal deletes every generation of a session, so a historical format generation kept for migration is gone too — acceptable because the whole point is that the session stops existing, and the alternative (deleting only the selected generation) leaves the session listed through its remaining artifacts.

Deletion does not close live handles. A write handle whose session was removed and which then appends re-materializes an artifact; the registry's ordering is what makes that unreachable through the product, and the seam's JSDoc states the obligation for any other caller. A session deleted while a cold reader holds it open reads from memory until it closes, which is the existing handle contract rather than a new failure mode.

The permission model follows the verb: a composition that grants `workspace/archiveSession` does not thereby grant `workspace/deleteSession`, and the sidebar hides the action when the endpoint is not allowed. The live-share endpoint table classifies it `owner-only`, so a viewer never sees the row.

## Testing

`packages/session/session-persistence/tests/remove.spec.ts` pins the default refusal and pre-work cancellation. `packages/session/session-persistence-jsonl/tests/remove.spec.ts` proves a removal leaves nothing under the project directory — every generation, a side artifact, and the legacy flat-file spellings — that an unknown id writes nothing, that an unmaterialized session stops being listed, that a corrupt header is still deletable, that a filesystem refusal leaves the session listed and is safe to repeat, and that a memoized parse cannot answer afterwards. `packages/workspace/workspace/tests/workspace.spec.ts` covers accounting and set pruning, the unknown-id no-op, the running-work refusal, the stop-before-remove order, the backend-failure rollback, and the `AggregateError` for a committed deletion whose prune failed. The API suites cover the two Remote codes and the client model's faithful `stopActivity` forwarding; the client suites cover the menu entry (label, danger flag, trash glyph, permission), the dialog's cancel/confirm split, and the list refresh.

## Related

- [Archiving a Session with running work](../feature/2026-09-21-archive-stops-running-session-work.md) — the activity and stop events this decision reuses with the inverted order.
- [Handle-based Session persistence](2026-08-27-handle-based-session-persistence.md) — the handle API removal deliberately does not go through.
