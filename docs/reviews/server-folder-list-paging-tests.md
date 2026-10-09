# Test Review: Server-side folder listing paging

**Plan:** `docs/plans/server-folder-list-paging.md`
**Brainstorm:** `docs/brainstorms/server-folder-list-paging.md`
**Date:** 2026-10-08

## Summary

The tests cover pinned server ordering, full-set search, window fetching, accumulated client rows, and folder deltas through public boundaries. This review validates both prior runs' six approved corrections and the additional approved metadata-invalidation coverage. Virtualization and manager-archive bootstrap wiring remain explicit exclusions, not open findings. The approved delta wire hard cut supersedes the brainstorm's compatibility proposal.

## Findings

### 1. Cold metadata expectations contradicted background refresh

- **Category:** over-specified
- **Severity:** critical
- **Location:** `server/src/folder-listing.test.ts`, session-derived metadata cache and order snapshot tests
- **Status:** resolved

The prior tests required fresh metadata before the nonblocking scan completed. The approved correction warms recency/search fixtures and gates refreshes with deferred promises. Tests require stale serving during TTL/invalidation refresh and stable existing pins after completion. Only fresh pins adopt refreshed metadata. The live-recency fixture warms disk metadata so its ordering assertion proves live activity overrides newer disk activity. TTL tests use a fake clock and assume no scan duration or filesystem order.

### 2. Wire responses lacked the computation epoch

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `shared/src/protocol.ts`, `server/src/ws-handler.test.ts`, `client/src/lib/stores/folder-store.svelte.test.ts`
- **Status:** resolved

The approved response contract requires `epoch`. Handler tests assert wire mapping. Client tests reject older responses and accept fresh responses computed after interleaved deltas. This replaces an arrival-time-only interpretation of staleness. The architecture and Tests interface inventory agree.

### 3. Connection pins lacked ownership and refresh coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/folder-listing.ts`, `server/src/folder-listing.test.ts`, `server/src/ws-handler.test.ts`
- **Status:** resolved

Approved interfaces add connection ownership, `releaseConnection`, and explicit `repin`. Tests require open-time pinning, early-command waiting, omitted-token reuse, cross-owner rejection, close release, and pending-pin release. Service-level assertions prove explicit refresh creates a new token and new order, then omitted-token commands adopt it. Client test wording describes open-time pin reuse, not implicit refresh. The plan retains first-command fallback when folder dependencies are unavailable at open.

### 4. Delta callback tests hid missing target paths

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/folder-registry.test.ts`, `server/src/repo-index.test.ts`, `server/src/server.test.ts`, `server/src/ws-handler.test.ts`
- **Status:** resolved

Approved callback interfaces carry `{ changedPaths, removedPaths }`. Registry tests assert update/createHub/disbandHub targets. Discovery tests assert additions and removals. Server tests require forwarding those targets to delta construction. The create-folder test requires the created canonical path. Empty callback payloads remain implementation placeholders and fail these tests.

### 5. Client tests required eager enumeration and omitted authoritative views

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `client/src/lib/stores/folder-store.svelte.test.ts`
- **Status:** resolved

Approved corrections remove eager `list_sessions` expectations. Loading and searching never enumerate sessions. Visible-row callers invoke `loadSessions` explicitly. Server query matches determine `visibleFolders`, while the accumulated cache retains other rows. `visibleSessions` narrows session-only matches through `matchedSessionIds`. The folder-tier selector test runs an active query and proves all loaded sessions remain visible. Clearing search preserves the cache and removes session narrowing. Open/bound-session restoration remains independent.

### 6. Session events lacked targeted metadata-invalidation coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/ws-handler.test.ts`, `server/src/server.test.ts`
- **Status:** resolved

The architecture requires metadata invalidation after session changes without folder deltas. The orchestrator approved this additional gap as one batch. Boundary tests require targeted invalidation for rename, delete, archive, unarchive, status changes, and session closure. They require existing session events and no delta construction. The plan records manager-archive bootstrap wiring as an approved integration exclusion because `server/src/index.ts` has no stable isolated seam. Implementation must still perform that invalidation without a folder delta.

### 7. New boundaries lacked failure paths

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/folder-listing.test.ts`, `server/src/ws-handler.test.ts`, `client/src/lib/stores/folder-store.svelte.test.ts`
- **Status:** resolved

Approved tests require registry failures to propagate from pin/query/delta construction and service failures to produce wire error responses. Metadata refresh failures never fail pin/query. They preserve the last good snapshot and recover after invalidation. A truly cold failure serves name-only ordering. Continuation and search failures preserve rows and permit retry. Test promises attach rejection handlers before fake-clock advancement to prevent test-generated unhandled rejections.

## Intent and boundary validation

| Intent                                                            | Test boundary                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| Favorite, recency, name, and deterministic path ordering          | `FolderListing.pin/query`                                      |
| Stable windows with fresh curation data                           | `FolderListing.query`                                          |
| Full-set folder/session search, filter then slice, archive filter | `FolderListing.query`                                          |
| Background session metadata and live activity                     | Injected summary/live-session ports through `FolderListing`    |
| Connection pin lifetime and explicit refresh                      | `FolderListing` and `WsHandler`                                |
| Delta targets, enrichment, and monotonic epochs                   | Registry/index callbacks, `buildDelta`, handler/server wiring  |
| Session-event metadata invalidation without folder deltas         | Handler commands and server callbacks                          |
| Accumulation, authoritative query views, and lazy session loading | `FolderStore` public methods/selectors                         |
| Live client re-sort and session event reconciliation              | Existing folder-store tests                                    |
| Infinite-scroll request continuation                              | `FolderStore.fetchNextWindow`                                  |
| Virtualized rendering and rendered-row call discipline            | Approved rendering-layer exclusion                             |
| Manager-archive bootstrap invalidation                            | Approved integration exclusion, required during implementation |
| Complete-list manager and hub-member consumers                    | Unchanged separate registry seams                              |
| Older client compatibility                                        | Superseded by the approved delta wire hard cut                 |

Tests use public interfaces and observable rows, tokens, events, and commands. Folder fixtures use canonical paths and fixed timestamps. Deferred promises control scan completion. Fake clocks control TTL and debounce. Filesystem tests use isolated temporary directories, not external discovery state. No new test reads private cache state.

## Validation

Closeout reran the checks against the reconciled worktree:

- `npm run check` passed. Client Svelte check reported zero errors and warnings. Server and shared TypeScript checks passed.
- `npm run test --workspaces --if-present -- --run` ran every workspace suite.
- Server: **855 passed, 44 failed**, across 61 files. The six reviewed files contain **207 passed, 44 failed**.
- Client: **773 passed, 17 failed**, across 60 files. The folder-store suite contains **19 passed, 17 failed**.
- SDK: **9 passed**, across one file.
- Separate JSON-reporter reruns confirmed the same server and client counts.
- All 61 failures belong to the topic contract. Listing/listMany/client method stubs throw `not implemented`. Other failures expose empty callback payloads, missing handler/server delegation and invalidation, or superseded eager-loading/refresh behavior.
- New behavioral tests are red. Unchanged pre-topic tests pass. Legacy tests strengthened or replaced for approved callback, lazy-loading, and repin decisions are also red. Those changed assertions are topic tests, not unrelated regressions.
- Failure names were compared with the pre-topic commit `1bd7574`. Only three retained pre-topic titles fail: registry notification, discovery notification, and forced client refresh. Their changed assertions require the approved path payloads and `repin: true`.
- No unhandled rejection reports appeared in the full run or JSON reruns. `git diff --check` passed.
- Prior review runs passed targeted ESLint and Prettier checks. Closeout also checks changed files before commit. Git hooks remain enabled.

The codemap is stale for the new listing seam and accepted Android wire break. This review reports the mismatch without expanding into codemap maintenance.

The Tests review stamp remains approved. No finding remains open. The red tests define the approved implementation contract, not unfinished review work.
