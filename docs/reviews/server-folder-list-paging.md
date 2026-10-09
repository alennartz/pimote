# Review: Server-side folder listing — pinned order, windowed fetch, server-side search

**Plan:** `docs/plans/server-folder-list-paging.md`
**Diff range:** `3f0f69329878de974b8f799eeba7ce8d6c702168..fa46f3cac8fc0b0914d96bc5e8acc260613829ba`
**Date:** 2026-10-09

## Summary

The plan was implemented faithfully: all 11 steps landed with their intended architecture, and test files changed only inside the authorized amendments (test immutability check over `81b326a..HEAD` is clean). Both review passes ran — plan adherence and code correctness — and produced 12 findings after deduplication. The headline risk is one critical paging defect that silently drops rows; the rest are warnings around lost deltas, missing epoch retries, and discovery-cache invalidation, plus three nits. One warning (Android `list_folders` truncation) falls inside the plan's accepted hard-cut debt and is recorded so the Android update covers it.

## Findings

### 1. Window offsets continue across a shrinking filtered order — rows silently skipped

- **Category:** code correctness
- **Severity:** critical
- **Location:** `client/src/lib/stores/folder-store.svelte.ts:240` (with `server/src/folder-listing.ts:217-224`)
- **Status:** open

The client paginates with `nextOffset = context.offset + data.folders.length`, but the server slices `[offset, offset+limit)` out of the current filtered pinned order. `matches` shrinks whenever a row stops resolving (external deletion, disband) or flips to `archived` with `includeArchived=false`. Scenario: 3500 folders, rows 0–99 fetched (nextOffset=100); a folder at position 12 is archived; the next window at offset 100 serves old rows 101–200 and old row 100 is never returned by any later window. One row is lost per above-frontier removal until a repin refetch from 0. The same skip occurs when `selectPin` transparently re-pins mid-pagination: the response serves a new ordering at the old offset, and `applyFolderWindow` adopts the new token while keeping the old offset. Silent folder omission is the failure mode this feature exists to prevent.

### 2. Android client silently truncates its folder list at 100 entries

- **Category:** code correctness
- **Severity:** warning
- **Location:** `shared/src/protocol.ts:489-494` (with `mobile/android/app/src/main/kotlin/com/pimote/android/protocol/Protocol.kt:65-69`, `SessionRepository.kt:283-285`)
- **Status:** open

`list_folders` now windows with a default `limit` of 100. Android sends no `offset`/`limit`, treats `data.folders` as the complete list, and has no `more`/`total` handling; `ignoreUnknownKeys = true` hides the drift. On a ~3500-folder server the app shows 100 folders and bootstraps sessions only for those. The plan accepts the Android hard cut (`Notes on the plan`: Android breakage remains accepted), so this is not a plan deviation. It is recorded because the break is silent and the plan's Android section names `folders_changed` explicitly — the pending Android update must cover `list_folders` paging, not only the delta event.

### 3. Open-hook materializations never reach clients as folder deltas

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/repo-index.ts:325-329,471-477`
- **Status:** resolved

Step 6 and the delta-reconciliation clarification require discovery additions to forward concrete targets through `setOnRefreshed` so `folders_changed` carries them. `runOpenHooks` ends with an unconditional `this.invalidate()` (`repo-index.ts:477`), which nulls the listing. The next read takes the cold path (`currentStamp`, `repo-index.ts:328`), and only `kickRefresh` calls `notifyRefreshed` — cold walks never notify, so the fact diff is absorbed silently. A source folder or hub materialized by an open hook therefore never emits a delta; clients keep the stale `missing: true` row (the `session_opened` event's `folder` field feeds session naming only, `folder-store` does not handle it), and tapping the row loops through `attemptOpen` instead of expanding until an explicit refresh. Pre-change, the TTL background refresh diffed and broadcast such rows.

### 4. Every folder open discards the warm discovery and git-status caches

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/repo-index.ts:471-477` (with `server/src/ws-handler.ts:488,547`)
- **Status:** resolved

Unplanned work: `runOpenHooks` runs on both `open_session` paths and calls `invalidate()` after every successful open, even when no hook materialized anything (hooks self-filter by path). `invalidate()` drops the listing stamp and `statusCache.clear()` re-probes git status for every repo, so the next `list_folders` window, pin, or registry listing blocks on a full discovery walk plus per-repo git probes. Step 1 pins "warm tree reads must not rescan"; this cache bust on a frequent user action reintroduces the latency class the slice removes. A narrower trigger — invalidate only when a hook actually provisioned, or a targeted refresh that still notifies — keeps the seam's contract.

### 5. Epoch-discarded windows have no retry trigger — views stall

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/folder-store.svelte.ts:228`
- **Status:** resolved

`requestFolderWindow` drops any response with `data.epoch < this.foldersEpoch` and returns; nothing reschedules. Any `folders_changed` broadcast between query start and response arrival discards the window, and deltas are frequent (every AGENTS.md save, git-status refresh with fact movement, any client's tag/favorite edit). If the discarded window was the initial load, `loadedForCurrentConnection` stays false and Dashboard's `$effect` re-runs `ensureLoaded()` only on a connection-status change or remount (`Dashboard.svelte:163-171`): the user sits on "No folders configured" though folders exist. Same for search — `search()` cleared `queryMatchPaths`, the response is discarded, and the user sees "No folders." until they type again. The discard itself is correct and tested; the missing retry is the bug.

### 6. Pinned order is frozen at connection open — later-created folders are unsearchable and uncounted

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-listing.ts:217`
- **Status:** open

`query()` computes matches only over `snapshot.paths`, the order pinned at WebSocket open; pins are replaced only by explicit repin (only `NewSessionDialog` triggers one). A folder created afterwards — `create_folder`, `create_hub`, or an external mkdir picked up by a TTL refresh — reaches the plain list via delta merge but is absent from every window, from `total`, and from every server-side search. Scenario: user creates hub "network", types "net" in the toolbar search; the server searches the pinned order, the hub is not in it, `queryMatchPaths` never gets it, and `visibleFolders` filters the row out. Recovery only via reconnect or the New Session dialog.

### 7. Dropped deltas leave phantom rows that refresh and reconnect never purge

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/folder-store.svelte.ts:237,169` (with `server/src/ws-handler.ts:1908`)
- **Status:** resolved

`applyFolderRows` merge-accumulates by path; the only row-removal mechanism is `folders_changed` `removedPaths`. `broadcastFoldersChanged` drops the whole delta on `buildDelta` failure (e.g., a transient `folderRegistry.list()` error) with just a `console.warn` and no retry, and a briefly disconnected client misses the broadcast outright. `invalidateConnection` deliberately retains `folders`, and `loadFolders()` (repin) also merges window 0 into the old cache. A folder deleted while a delta is lost stays in the client cache for the rest of the SPA session: it renders in `visibleFolders`, manual refresh does not remove it, and only a hard page reload clears it. There is no cache-replace path anywhere in the store.

### 8. `file_put` delta misfiles non-row folders as removals and churns global state on every AGENTS.md save

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:829-835` (with `server/src/folder-listing.ts:243`)
- **Status:** resolved

`resolveContainingFolder` returns the file's immediate directory, but rows are keyed by folder roots. For nested `folder/sub/AGENTS.md` the containing folder is not a row; `buildDelta` classifies any unresolved touched path as `removed`, so the event broadcasts `removedPaths: [folder/sub]` (a no-op) while the intended row update for `folder` is never sent. The branch also runs for the global `~/.pi/agent/AGENTS.md` opened from the FolderList toolbar button: every save calls `repoIndex.invalidate()` (forcing a full cold re-walk on the next read) and bumps the listing epoch via a broadcast-global no-op delta, which discards in-flight `list_folders` responses (feeds finding 5). AGENTS.md front-matter is the persona marker, so the lost row change is real.

### 9. Pin adoption is tracked in two layers that can diverge

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1983-2013` vs `server/src/folder-listing.ts:256-296`
- **Status:** open

The same business operation — adopt and track this connection's order pin — has two implementations: `WsHandler.trackPin` (`folderToken`, `pendingPin`, `pinGeneration`) and `FolderListing.ConnectionPin` (`token`, `pending`, `generation`). They already disagree: a transparent re-pin inside `selectPin` (stale/foreign token) updates the service's `connection.token` but never `WsHandler.folderToken`, which then serves stale tokens on omitted-token queries and forces a fresh re-pin each time (order churn, feeding finding 1). The listing's `connection.pending` branch (`folder-listing.ts:292`) is unreachable in production because `resolveOrderToken` always passes an explicit token — dead state maintainers will keep honoring. Per the design doctrine, one business operation belongs in one layer.

### 10. `disbandHub` mutates the registry document before `rm`; an `rm` failure reports failure but disbanded anyway

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-registry.ts:420-421`
- **Status:** resolved

The new order splices `doc.hubs` before `await rm(removed.path, ...)`. `rm` with `force: true` still throws on EPERM/EBUSY; on throw the command returns an error to the user, but the in-memory document already lost the hub and the next `persist` writes it — the hub silently disbanded despite the error response, and no delta fires. The previous code removed from the doc only after a successful `rm`. Capturing `doc.hubs[index]` without splicing first keeps the failure atomic.

### 11. Pins and connection entries leak when a query races `cleanup()`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-listing.ts:187-197,256-262,298-302`
- **Status:** resolved

`releaseConnection` is the only cleanup for owned pins, and `sweepOrphans` deletes only snapshots with `owner === undefined`. If a folder command is in flight when the socket closes, `selectPin`/`pin(connectionId)` runs after `releaseConnection`, and `connectionPin()` re-creates the connection entry and registers a new owned pin that nothing will ever release. Each occurrence leaks one `OrderSnapshot` (up to 3500 paths) and one `ConnectionPin` for the process lifetime. The interface doc claims pins are garbage-collected on close plus a TTL sweep for orphaned tokens; the sweep does not cover this case.

### 12. Metadata refresh clears its invalidation bookkeeping on failure and fetches rows it does not use

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-listing.ts:314-332`
- **Status:** resolved

Two issues in `refreshMetadata`. First, the `finally` clears `refreshAll`/`invalidatedPaths` whenever `version === this.invalidationVersion`, including after a failed refresh (the catch swallows). A failed targeted refresh therefore marks stale paths fresh; renamed/deleted-session search text and `lastActivity` stay wrong until the 30 s TTL full refresh. Second, partial (invalidation-driven) refreshes execute `rows ?? await this.deps.listRows()` — a full registry merge over ~3500 rows whose result is never read — and `onStatusChange` calls `invalidateSessionMetadata` on every session status transition (`server/src/server.ts:195-201`), so that wasted merge runs repeatedly during active agent use.

## Verified Clean

Both passes were run; findings above are their merged, deduplicated output (one plan-deviation finding and its correctness duplicate were merged). Notable clean results: test immutability over `81b326a..HEAD` — all test-file changes fall inside the authorized amendments; `server/src/folder-listing.ts` order snapshot, two-tier search, window clamping, epoch capture-before-await, and `buildDelta` reconciliation match the plan; SDK untouched; complete-list consumers (`pimote_list_folders`, hub-member management) stay unwindowed; `folder-store` session-listing machinery (structural epoch, `touchedSessions` reconciliation, single-flight `loadSessions`) is correct; `repo-index` single-flight discovery and status-TTL handling are sound; no injection surface in server-side search; FolderList virtualization guards check out.
