# Plan: Child sessions are sessions

## Context

A child view frozen at its pre-disconnect state, while the parent received the child's idle notification, exposed the asymmetry: root sessions sync as a surface with observers and cursor replay, child views sync as a connection-owned record with generation checks. Missed traffic has no recovery path, and the client cannot tell a live view from a dead one.

Symptom record: `docs/subagent-ui-bugs.md`, BUG-014.

Goal: one sync model for both session kinds. A child is a session with a parent, not a special transport.

Out of scope: Android child views, child URL routes, per-child archive, auth.

## Target model

**One surface per child path.** `SubagentHost` owns at most one `SessionSurface` per `(rootSessionId, path)`. It acquires the provider lease when the first observer attaches and releases it when the last observer detaches. Two clients sharing a child share one surface, one buffer, one lease. Different users share the surface the same way.

**Observers are connections.** `observers: Map<clientId, { cursor }>`, mirroring `ManagedSlot.observers`. A stale socket cannot detach the replacement's observer because detach compares socket identity, the way `detachObserver(sessionId, clientId, ws)` already does (`session-manager.ts:1681-1686`). The host connection token and its `connected` flag both disappear.

**Reconnect is a request, not a push.** The client asks for each open view with its last `viewCursor`, exactly as it asks for each open root with `lastCursor` (`connection.svelte.ts:735-745`). The server answers with events or a snapshot. There is no server-initiated restore path and nothing to lose while a socket is down.

**Cursors survive surfaces.** A child surface buffer starts at the wall-clock base, the rule already used for root slots (`session-manager.ts:587-593`). A cursor from a dropped surface then reads as stale and yields a snapshot instead of a false caught-up.

**The profile holds both kinds.** A user's open set carries child entries beside root entries. Link on `subagent_open_view`, unlink on `subagent_close_view`, cascade on root close, delete, archive, or detach.

**Child entries sync, rendering waits.** Chip order and selection stay root concepts. The dashboard renders open views exactly as today; child views open from the tree and the panel. A UI pass later decides whether children earn chips.

**The hold counts observers.** The idle hold keyed off provider leases stays, and the lease refcount now derives from observers, so one counter exists instead of two.

Tradeoff the owner has accepted: a socket close detaches its observers, so a child that settles while the app is closed delivers its idle notification to the parent. The retention half of `6f81439` (BUG-012) is superseded. The half that keeps an unavailable view from marking a running child stopped stays.

## Wire changes

`shared/src/protocol.ts`. Hard cut, no compatibility shim: no Android client consumes these frames.

| Frame                            | Change                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent_open_view`             | Adds optional `viewCursor`.                                                                                                                                                     |
| `SubagentOpenViewResponseData`   | Adds `viewCursor` and `mode: 'events' \| 'snapshot'`. Drops `attachmentGeneration`.                                                                                             |
| `subagent_close_view`            | Keeps `path` only. Drops `incarnation` and `attachmentGeneration`.                                                                                                              |
| `subagent_view_snapshot`         | Drops `attachmentGeneration`.                                                                                                                                                   |
| `subagent_view_event`            | Drops `attachmentGeneration`.                                                                                                                                                   |
| `subagent_view_closed`           | Drops `attachmentGeneration`. `reason` becomes `'replaced' \| 'unavailable' \| 'teardown'`.                                                                                     |
| Every other `subagent_*` command | Drops `attachmentGeneration`. `incarnation` stays as the runtime guard.                                                                                                         |
| Open error                       | New code `subagent_view_unavailable` for a path the host cannot serve.                                                                                                          |
| `user_sessions_changed`          | Adds `views: { sessionId, rootSessionId, path, folderPath }[]` — the user's open child views. `sessions`, `order`, and `selectedSessionId` keep their shape and stay root-only. |
| `reorder_sessions`               | Unchanged.                                                                                                                                                                      |

## Server work

### 1. Surface seam (`session-surface.ts`)

- `SessionSurfaceOptions.baseCursor?: number`. Pass it to `EventBuffer` in place of the hard `0` at `:593`.
- Expose `replay(after)` to callers outside the surface. It exists; confirm its shape covers the child host.
- No other change. `attachObserver`, `refreshSnapshot`, and `invalidateReplay` already give the needed behavior.

### 2. Host ownership (`subagent-host.ts`)

- Replace `ConnectionRecord` and `ViewRecord` with one `ViewRecord` per path: `{ path, incarnation, lease, surface, snapshot, observers, closed, transition }`.
- Delete `connections`, `inFlightOpens` keyed by connection, `generation`, `randomGeneration`, `attachmentGeneration` everywhere.
- Delete `disconnect`, `reconnect`, `refreshAttachment`, `releaseConnection`, the `connected` flag, and the token accessors.
- `openView(clientId, path, after?)`: attach observer; acquire lease and build surface when the record is absent; return `{ mode: 'events', viewCursor }` or `{ mode: 'snapshot', viewCursor }`. Emit replayed events as `subagent_view_event` frames before the response, the way root replay precedes the `open_session` response.
- `closeView(clientId, path)`: detach observer. Last detach closes the record and releases the lease.
- `refreshSurface` survives only for lease rebinds, incarnation changes, and tree navigation. New surfaces take `baseCursor` from the previous cursor.
- `teardown`, `stop`, `resurrect`, `shutdown`, and provider-fed topology are unchanged.

### 3. Routing (`ws-handler.ts`)

- Delete `subagentConnectionTokens`, `rememberSubagentConnectionToken`, `forgetSubagentConnectionToken`, `subagentConnectionToken`, `boundSubagentViewListeners`, the per-client listener map, and the restore loop in `claimSession` (`:2096-2100`).
- Child view frames route through the surface's observer fan-out. `sendSubagentViewChange` takes the originating path and observers directly.
- `subagent_open_view` links the child entry for the requesting user and emits `user_sessions_changed`. `subagent_close_view` unlinks it.
- Cascade: root `close_session`, `delete_session`, `archive_session`, and `detach_session` unlink the root's child entries. Root slot reset or replacement unlinks them too, since no surface survives.
- `cleanup()` detaches this socket's observers. That is the whole disconnect path.

### 4. Profiles (`user-profiles.ts`)

- Add `views: ChildViewRef[]` to `UserProfile` and the persisted document. `linkView`, `unlinkView`, `views(user)`, and `unlinkViewsUnder(rootSessionId)`.
- `sessions`, `order`, `selectedSessionId`, `orderVersion`, `link`, `unlink`, `reorder`, and `selection` stay root-only and keep their invariants.
- `gc(validRoots, isValidChild)` drops views whose root is gone, whose path is absent from the root's `.subagents/agents.jsonl`, or whose child session id disagrees with that record. A malformed or missing `agents.jsonl` drops the view.
- Root `unlinkAll` also removes that root's views.

## Client work

### 5. Attachment state (`session-registry.svelte.ts`)

- Attachment identity becomes `(rootSessionId, path)`. Delete `attachmentGeneration`, `pendingViewEvents`, and the generation arms of the snapshot and event guards at `:1503-1511` and `:1572`.
- Ordering is by `viewCursor` alone. An `incarnation` mismatch closes the attachment as `'replaced'`.
- `openSubagentView` sends the stored `viewCursor`; a `subagent_view_unavailable` response closes the attachment and shows the notice. This kills the ghost through a response, not a lost push.
- `closeSubagentView` sends `{ path }`.

### 6. Restore (`connection.svelte.ts`, `session-registry.svelte.ts`)

- `subagentViewCursors` becomes the restore input it was meant to be (`connection.svelte.ts:195-201`).
- After the root restore pass in `dispatchRestores`, open every entry in `event.views` with its cursor, in one pass with the same error handling as `restoreSession`.
- A view whose root is not in this client's subscribed set is skipped, not opened; the root open brings it back.
- Selection stays root-only. Which child view is inspected remains local UI state.

### 7. UI

- No chip, order, or selection change. `Panel.svelte:176-186` reopens when the registry reports no live attachment instead of re-selecting a dead one.

## Deletions this buys

- `subagent-host.ts`: connection records, tokens, `connected`, `disconnect`, `reconnect`, `releaseConnection`, per-connection `inFlightOpens`, `recordsByPath` sets, record generations, rebuild-on-reconnect.
- `ws-handler.ts`: token bookkeeping, per-slot listener maps, the claim-time restore loop, the detach-time release loops.
- `session-manager.ts`: the `reconnectGraceMs` comment stub left at `:67-68`.
- Client: generation guards, pending-event staging, two of the three snapshot guards.

## What stays child-specific

- Parent path and incarnation.
- Provider controls: stop, teardown, resurrect.
- No slot, no idle clock, no reaper, no archive, no profile row of its own. The root's file owns its lifecycle.

## Tests

- `subagent-host.test.ts`: two clients share one surface and one lease; last detach releases; a stale cursor yields a snapshot; an open after a surface drop snapshots; observer detach is socket-guarded.
- `session-surface.test.ts`: `baseCursor` rejects a predecessor's cursor.
- `user-profiles.test.ts`: `views` link and unlink; root chip order and selection ignore views; cascade on root unlink; GC drops stale views.
- `event-buffer.test.ts` around stale-cursor behavior: no change expected, one case asserted for children.
- `session-registry.test.ts`: a restore of `views` opens each view with its stored cursor; `subagent_view_unavailable` closes it; a delta applies without a snapshot.
- `tools/manual-test/PLAN.md` journey 15: two browsers on one user, one opens a child, the other follows; close the network, let the child settle, reconnect, both converge.

## Gates

1. Plan review (this document).
2. Phases 1-3 land behind no feature flag; server tests green.
3. Phases 4-4b (profiles) green; wire smoke passes.
4. Phases 5-7; web client works against one user, two tabs.
5. Subagent review pass: `comment-sicko`, `spaghetti-sicko`, `test-sicko`, `documentation-sicko`. Fix findings.
6. DR written last, recording the model, the superseded retention rule, the hard cut, and the cursor rule.

## Risks

- Observer-scoped leases reopen BUG-012's settle race during a socket gap. Accepted; the profile reattaches within one reconnect cycle.
- Profile GC now reads child directories. A slow or missing `agents.jsonl` must drop the view, not fail the boot sweep.
- Two parallel open sets (`sessions` and `views`) mean one more invariant to keep honest: a view whose root is not in the set is stale. Cascade and GC own that rule.
- Multi-user observation changes who can hold a child open. Expect the hold to last while any user watches.
- The hard cut breaks any out-of-tree client that sends `attachmentGeneration`. Android ignores these frames, so the shipped pair stays in lockstep.
