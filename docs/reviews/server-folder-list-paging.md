# Review: Server-side folder listing — pinned order, windowed fetch, server-side search (re-review of fixes)

**Plan:** `docs/plans/server-folder-list-paging.md`
**Diff range:** `fa46f3c..e933fa1` (fix scope; re-review of the review at `2399e9f`)
**Date:** 2026-10-09

## Summary

The fix commits resolve 10 of the 11 prior findings cleanly and one partially (phantom rows survive a reconnect). The fix diff introduces four new findings — three warnings and one nit. The most consequential: the open-hook delta diff is poisoned by the status-cache clear, so one first-open of a missing folder broadcasts a delta carrying roughly the whole listing (~3500 rows) to every client. Prior findings 3, 4, and 9 (the structural dual-layer pin violation that triggered this cycle) are verified resolved with the intended behavior. Test changes in the fix commits are legitimate regression tests, not immutability violations.

## Findings

### 1. Phantom rows still survive a reconnect

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/folder-store.svelte.ts:237,169` (with `server/src/ws-handler.ts:1908`)
- **Status:** open

Partial resolution of prior finding 7. Explicit refresh now replaces the cache (repin + offset 0 + no query), but the reconnect path still merges: `invalidateConnection` retains `folders`, and `ensureLoaded` merges window 0 of the new connection's pin, so rows deleted while deltas were lost survive a reconnect for the rest of the session. `broadcastFoldersChanged` still drops a failed `buildDelta` with only a `console.warn`, so manual refresh remains the sole heal. Remaining gap: purge on the reconnect path, and/or a delta retry or periodic reconcile.

### 2. Stale-window retry resumes at the wrong offset after a discarded offset-0 window

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/folder-store.svelte.ts:233-235`
- **Status:** open

The retry re-issues `fetchFolderWindow(this.nextOffset, context.repin)`. For a discarded continuation window that is right; for a discarded offset-0 window it is wrong. Scenario: the scan advanced (`nextOffset = 200`), the user toggles Show archived (offset 0, new filter, same token), and a delta epoch-discards its response. The retry fires at offset 200 under the new filter; `orderReplaced` is false (token unchanged), so `nextOffset` jumps to `200 + len` and `fetchedPrefix` is not cleared. The archived rows the toggle adds at new-filter positions 0–199 are never fetched, and `shrank` cannot repair holes outside `fetchedPrefix`. The same path drains the prior finding 7 refresh fix: a discarded `loadFolders` repin retried at the stale offset fails the cache-replace branch's `context.offset === 0` condition, so the authoritative replace degrades to a merge. The retry should honor `context.offset === 0 ? 0 : this.nextOffset`, or the toggle/refresh paths should reset `nextOffset` before issuing.

### 3. Open-hook delta diff is poisoned by the status-cache clear — every repo reported as changed

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/repo-index.ts:467-485`
- **Status:** open

`before = currentFacts()` fingerprints fold in warm git statuses (`status?.branch ?? entry.branch`). `invalidate()` clears `statusCache`, and `currentStamp(false)` re-walks without re-probing, so `notifyRefreshed(before)` diffs neutral stamp facts (`branch: null, dirty: false`) against the warm before-facts. Every repo whose status was probed — effectively all of them — lands in `changedPaths`. One first-open of a missing source folder therefore broadcasts a `folders_changed` delta carrying roughly the whole listing (~3500 rows, hubs with full `repos` arrays) to every client, bumps the epoch (discarding in-flight windows), and trips `shrank` restarts under an active query. The rows are correct but the fix's intent — concrete targets — is defeated and the event is O(all rows). Diff without status facts, or re-probe before diffing.

### 4. Session-metadata-driven query-match shrink has no restart trigger

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/folder-store.svelte.ts:337-341` (with `server/src/folder-listing.ts:217-224`)
- **Status:** open

The filtered order also shrinks when session-derived metadata changes: a `session_deleted`/`session_renamed` that strips the query text removes a session-tier match from `matches`, but session events call only `invalidateSessionMetadata` — no `folders_changed` delta fires. The client's `shrank` check watches folder deltas exclusively, so a match leaving the set inside the fetched prefix shifts rows up and the next window at the old `nextOffset` skips one row — the prior finding 1 bug class through a shrink source the fix does not observe. Narrow trigger (active session-tier search, scan past one window, concurrent session edit), but the skip is silent and permanent for that scan.

### 5. `query()` can serve an empty success window under a superseded pending pin

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-listing.ts:232,324`
- **Status:** open

The pin-layer collapse made `selectPin`'s `connection.pending` branch load-bearing. If a concurrent `pin()` (repin or transparent re-pin) bumps the connection generation before an awaited pending `createPin` registers its snapshot, the write is skipped, `this.pins.get(pin.token)` is undefined, and `query` silently returns `rows: [], total: 0, more: false` with a dead `orderToken`. The current web client masks it (single-flight plus generation guards discard such responses), so this is latent — but the service contract now owns this path alone, and any caller without that guard sees an empty "successful" folder list.

## Prior Findings — Verification

Verified against `fa46f3c..e933fa1`; statuses from the prior review (`2399e9f`):

1. Window offsets skip rows across a shrinking filtered order — **resolved** (delta-driven shrink restarts the scan via `fetchedPrefix`; transparent re-pin restarts at 0 via `orderReplaced`; residual variant recorded as finding 4 above).
2. Android truncates `list_folders` at 100 entries — **resolved as documented accepted debt** (plan's sanctioned hard cut; carried to the Android update).
3. Open-hook materializations never reach clients as folder deltas — **resolved** (`runOpenHooks` captures pre-provision facts, invalidates and re-walks inline only when a hook provisions, forwards the concrete fact diff through `notifyRefreshed` → `setOnRefreshed` → `buildDelta`; side effect recorded as finding 3 above).
4. Every folder open discards warm discovery and git-status caches — **resolved** (`invalidate()` only when the folder was missing before and exists after provisioning).
5. Epoch-discarded windows have no retry trigger — **resolved** (`staleWindowRetry`, bounded at 5 consecutive retries, reset on accepted windows; flaw recorded as finding 2 above).
6. Pinned order frozen at connection open — **resolved** (`buildDelta` appends resolvable new rows at the tail of every live pin; tail-append is offset-safe).
7. Dropped deltas leave phantom rows — **partially resolved** (see finding 1).
8. `file_put` delta misfiles non-row folders — **resolved** (`resolveOwningFolderRow` maps nested edits to the deepest owning row; global instructions trigger no invalidate, delta, or epoch bump).
9. Pin adoption tracked in two layers — **resolved** (`WsHandler.trackPin`/`folderToken`/`pinGeneration` removed; `FolderListingService` solely owns pin adoption; tests assert at the wire boundary).
10. `disbandHub` mutates before `rm` — **resolved** (doc entry kept until `rm` succeeds).
11. Pins leak when a query races `cleanup()` — **resolved** (`releaseConnection` tombstones; racing pins become owner-less TTL-swept orphans; tombstones swept).
12. Metadata refresh clears bookkeeping on failure, fetches unused rows — **resolved** (clears only on success; partial refreshes read only invalidated paths).

Test-change judgment for the fix commits: clean. `folder-listing.test.ts` additions pin the omitted-token-awaits-pending-pin behavior at its new home; `ws-handler.test.ts` swaps the fake's token-echo model for the service pin contract and re-expresses two assertions at the wire boundary. The replaced assertions pinned the divergent two-layer token passing that prior finding 9 ruled a defect, and every planned behavior keeps an equivalent assertion. Targeted suites pass: 232 server tests (folder-listing, repo-index, ws-handler, folder-registry), 36 folder-store tests.
