# Plan: Server-side folder listing — pinned order, windowed fetch, server-side search

## Context

A folder source (SDK extension) contributes ~3.5k folders and the dashboard lags: `list_folders` ships every row, the client fires `list_sessions` per folder for the recency sort and chips, `folders_changed` rebroadcasts the full list, and every row renders. This makes folder listing server-driven: one pinned order per connection, offset/limit windows fetched on infinite scroll, two-tier search computed server-side, virtualized rendering on the client. See `docs/brainstorms/server-folder-list-paging.md` for the exploration and the reasoning behind the settled decisions (pinned order, same sort logic server-side, delta `folders_changed`, wire epoch, hard cut for old clients).

## Architecture

### Impacted Modules

- **Protocol** (`shared/src/protocol.ts`) — `ListFoldersCommand` gains optional `offset`/`limit`/`query`/`includeArchived`/`orderToken`; `ListFoldersResponseData` gains `total`/`orderToken`/`more`; `FoldersChangedEvent` changes from a full-list broadcast to a delta (`changed` rows, `removedPaths`, `epoch`); `FolderInfo` gains optional `matchedSessionIds`.
- **Server** — new `folder-listing.ts` module (below) owns ordering, search, and windowing. `ws-handler.ts` `list_folders` case shrinks to parse → `folderListing.query(...)` → respond; `broadcastFoldersChanged` becomes a delta emitter where each mutation site (`update_folder`, `create_folder`, `disband_hub`, registry `onChange`) knows exactly which paths changed. `folder-registry.ts` stays the curation-persistence owner; it gains no query logic. `session-summaries.ts` gains a batch listing entry so a cross-folder pass reuses its per-file cache.
- **Web Client** — `FolderStore` becomes a path-keyed accumulating cache over a pinned order (fetch-next-window, search-merge, epoch guard, live re-sort of the fetched subset); `FolderList.svelte` renders the accumulated set through a virtualizer. Per-folder session _lists_ load only for rows in the fetched set as they render (replacing today's fan-out over every folder); folder-row session/git indicators come from server enrichment in the row payload, never from client enumeration. Vocabulary: "chips" in this project means the chat view's open/bound-session buttons — a client-local concern (persisted in local storage, restored eagerly at startup) that is fully independent of folder listing; it feeds the live re-sort and never waits on window fetches.
- **SDK** — unchanged. `FolderInfo` is wire-protocol only; `packages/sdk` carries source-entry types (`RepoInfo`/`SourceEntry`) because folder sources contribute those — no SDK consumer sees `FolderInfo`, so no twin is added (an earlier draft of this plan said otherwise; it was wrong). The folder-source seam (`FolderSource.list()`) is unchanged.
- **Android Client** — `folders_changed` mirror breaks by decision (hard cut). **Accepted debt: Android is left broken here** and needs its own update; no compat shim will be built.
- **Development Tooling** — dashboard/folders smoke harness and manual-test journey touch the folder list; windowed fetch and delta events change their wire expectations.

### New Modules

**`server/src/folder-listing.ts` — the folder listing service.** A deep module at the seam between ws-handler and the folder model: everything about _which folders, in what order, which slice_ lives behind a small interface. Dependencies: the folder registry's row listing (merged scan + curation, TTL-cached at the repo-index boundary per DR-053), and `SessionSummaryIndex` for session-derived metadata (recency + search text). It owns three internal pieces: a server-wide **session-derived metadata cache** (folder → `lastActivity`, folder → searchable session text; stale-while-revalidate on a TTL, invalidated by session events), **order snapshots** (pins) keyed by token, and the monotonic **epoch**. Discovery caching stays at the repo-index adapter boundary — this module caches derived metadata and orderings, never scan results.

### Interfaces

All rows crossing the wire are `FolderInfo` (protocol) plus an optional per-row search annotation:

```ts
// shared/src/protocol.ts (additions/changes)
interface ListFoldersCommand extends CommandBase {
  type: 'list_folders';
  offset?: number; // default 0
  limit?: number; // default 100, server-clamped to [1, 200]
  query?: string; // two-tier search over the full set, case-insensitive substring
  includeArchived?: boolean; // default false
  orderToken?: string; // omitted → server pins a fresh order
}
interface ListFoldersResponseData {
  folders: FolderInfo[]; // rows may carry matchedSessionIds?: string[]
  roots: string[];
  total: number; // matches under query + includeArchived, over the whole set
  orderToken: string; // token this window was served under (client adopts it)
  more: boolean;
}
interface FoldersChangedEvent {
  type: 'folders_changed';
  changed: FolderInfo[]; // created/updated rows, fully populated + session-count enrichment
  removedPaths: string[];
  epoch: number; // bumped on every emission
}
// FolderInfo gains:
//   matchedSessionIds?: string[];  // present when matched via the session tier
```

**Server seam — `FolderListingService`:**

```ts
interface FolderListingService {
  /** Pin the current order; returns a token referenced by window queries. */
  pin(): Promise<{ token: string; epoch: number }>;
  /** Serve one window under a pin. Raw params; normalization is internal:
   *  offset defaults 0, limit defaults 100, clamped to [1, 200]. */
  query(req: { token?: string; offset?: number; limit?: number; query?: string; includeArchived?: boolean }): Promise<{
    rows: FolderInfo[];
    total: number;
    more: boolean;
    orderToken: string;
    epoch: number;
  }>;
  /** Build the folders_changed delta for touched paths and bump the epoch.
   *  Emission-side invariant: every returned event carries the bumped epoch. */
  buildDelta(changedPaths: string[], removedPaths: string[]): Promise<FoldersChangedEvent>; // async: rows re-resolve through the registry listing
  /** Drop cached session-derived metadata (all, or for the given folders). */
  invalidateSessionMetadata(folderPaths?: string[]): void;
}
```

Behavioral contracts:

- **Order snapshot.** A pin is an ordered array of canonical folder paths, snapshotted from the rows and session-derived metadata at `pin()` time: `favorite desc → lastActivity desc → name asc → path asc` (path is the deterministic tiebreak stable pagination needs; today's contract is favorite → recency → name). The pin holds _order only_ — row data is re-resolved from the registry at query time, so curation edits are never stale against an old pin.
- **Pin lifecycle.** Pins live for the connection; garbage-collected when the connection closes (plus a TTL sweep for orphaned tokens). A query with an unknown/expired token transparently re-pins and serves the window under the new token (returned in `orderToken`; the client adopts it). Rows merge by canonical path client-side, so a mid-scroll re-pin cannot duplicate.
- **Query semantics.** `query` filters the full pinned order — never loaded rows only. Two tiers, OR'd: folder tier matches display name (persona name if present, else folder name), name, path, tags; session tier matches session `name`/`firstMessage`. A folder-tier match returns the row without `matchedSessionIds` (all its sessions shown, matching today's behavior); session-tier-only matches return `matchedSessionIds` with just the matched session ids. Filter then slice: `total` is the post-filter count over the whole set; the window is `[offset, offset+limit)` of the filtered order.
- **Session-derived metadata cache.** One server-wide cache (`folder → lastActivity` as `max(session.modified)`, `folder → session search text`) fed by a batched pass over `SessionSummaryIndex.list()` for all known folder paths, which itself caches per-file parses by mtime+size. `lastActivity` folds in live in-memory sessions at pin/query time, so actively-running folders rank as most-recent regardless of file-flush cadence. Cold starts serve the previous snapshot while refreshing in the background — `pin()` and `query()` never block on a full 3.5k-folder scan. Invalidated by session events (rename, delete, archive toggle, state change) and by a TTL (default 30s, aligned with the repo-index TTL).
- **Epoch.** One monotonic counter, bumped whenever a `FoldersChangedEvent` is emitted. `query()` stamps responses with the epoch observed at computation time; the client discards a response whose epoch is older than the newest event it has seen and applies fresh ones regardless of interleaving.
- **Deltas.** Each mutation site reports the paths it touched; `buildDelta` re-resolves those rows (full `FolderInfo` + session-count enrichment) and returns the event with `changed`/`removedPaths` and the bumped epoch. ws-handler only sends it. No diffing machinery: mutations know their targets.
- **`folders_changed` is registry/discovery-mutated only.** Session activity (status changes, renames, deletes, archive toggles) keeps flowing over the existing session events; the client updates row indicators and its local re-sort from those, without refetching windows or touching the pinned order.
- **Complete-list consumers stay unwindowed.** The manager tool `pimote_list_folders` and hub-member management keep their own complete-list seams over the registry listing; the windowed contract applies only to the `list_folders` protocol command. Out of scope here.

**Client seams — `FolderStore` (reshaped, same location):**

```ts
class FolderStore {
  // Path-keyed accumulating cache; the view derives from it.
  ensureLoaded(): Promise<void>; // pin + first window (replaces full load)
  fetchNextWindow(): Promise<void>; // next offset window when the view nears the end
  search(query: string): Promise<void>; // debounced (250ms); fetches offset-0 window for the query and merges matches in
  loadSessions(path: string): Promise<void>; // called for visible rows only
}
```

- The view sorts the fetched subset live (favorite → recency → name, as today) — driven by the client's open/bound-session state and whatever session data it has already loaded; sorting never triggers a session fetch. Server windows are fetched in pinned order.
- Search results are server-authoritative: with a query active, the view shows the rows the server returned for that query (folder-tier matches with all their sessions; session-tier matches with `matchedSessionIds` narrowing the lazy-loaded session list). Scroll under an active query fetches further match windows.
- `folders_changed` merges `changed` rows and drops `removedPaths` from the cache; rows sorting past the fetched frontier sit in cache and appear when scrolled to.
- Virtualizer supplies the visible range; `loadSessions` runs for rendered rows in the fetched set and never for the whole set. The open/bound-session restore path loads its sessions eagerly on startup, independent of window fetches.

### Technology Choices

- **`@tanstack/svelte-virtual`** for list virtualization (user-selected). Rows are variable-height (chip rows; some expand to session lists), which is exactly its dynamic-measurement support; `svelte-virtual-list` was rejected as weak on variable heights, hand-rolled windowing as bespoke jank-fixing we'd maintain.
- No other new dependencies: offset/limit windowing, the metadata cache, and delta emission are plain TypeScript over the existing seams.

## Tests

**Pre-test-write commit:** `3f0f69329878de974b8f799eeba7ce8d6c702168`

### Interface Files

- `shared/src/protocol.ts` — wire additions: `ListFoldersCommand` gains `offset`/`limit`/`query`/`includeArchived`/`orderToken`; `ListFoldersResponseData` gains `total`/`orderToken`/`more`; `FoldersChangedEvent` becomes a delta (`changed`, `removedPaths`, `epoch`); `FolderInfo` gains `matchedSessionIds?`.
- `server/src/folder-listing.ts` — `FolderListingService` (`pin`/`query`/`buildDelta`/`invalidateSessionMetadata`), `FolderListing` stub, `FolderListingDeps` (registry row listing, batched session summaries, live sessions), `FolderPin`/`FolderQueryRequest`/`FolderQueryResult`.
- `server/src/session-summaries.ts` — `SessionSummaryIndex.listMany()` batch entry stub (cross-folder pass reusing the per-file cache).
- `server/src/ws-handler.ts` — `broadcastFoldersChanged` reshaped to the delta emitter (service-built delta, paths from mutation sites); `folderListing` added to the connection deps; `list_folders`/`create_folder`/`file_put` call sites rewired.
- `server/src/server.ts` — `createServer` takes `folderListing`; registry `onChange` and repo-index `setOnRefreshed` route through the delta emitter.
- `server/src/index.ts` — constructs `FolderListing` over the shared `SessionSummaryIndex`, the registry listing, and live sessions.
- `client/src/lib/stores/folder-store.svelte.ts` — `FolderStore` gains `fetchNextWindow()`/`search()` stubs; `applyFoldersChanged` reshaped to the delta contract (stub).

### Test Files

- `server/src/folder-listing.test.ts` — the folder listing service: order snapshot, pin lifecycle, windowing, two-tier search, metadata cache, epochs, delta construction.
- `server/src/session-summaries.test.ts` — adds `listMany()` batch listing (grouped by folder path; empty for folders without sessions).
- `server/src/ws-handler.test.ts` — `list_folders` window delegation/mapping; `broadcastFoldersChanged` sends the service-built delta to every client; `create_folder` names its created path in the delta.
- `server/src/server.test.ts` — registry-mutation and repo-index-refresh wiring delivers the service-built delta to every client.
- `client/src/lib/stores/folder-store.svelte.test.ts` — windowed fetching (pin adoption, next-window merge, more=false halt), debounced search, delta merge/drop, stale-response guard.

### Behaviors Covered

#### FolderListingService — order snapshot

- Serves windows ordered `favorite desc → lastActivity desc → name asc → path asc`; path is the deterministic tiebreak.
- `lastActivity` derives from on-disk session summaries; a folder with a live in-memory session ranks as most-recent regardless of file-flush cadence.
- A pin holds order only: curation edits after `pin()` appear in query-time row data without reordering the pinned window.

#### FolderListingService — pin lifecycle

- A query under an unknown/expired token transparently re-pins and serves the window under the new `orderToken`; continuation windows under the adopted token cover the rest of the same order.

#### FolderListingService — windowing

- `offset` defaults to 0, `limit` defaults to 100; `limit` is clamped to [1, 200].
- `total` is the post-filter count over the whole set; `more` is false once the window covers the filtered order.

#### FolderListingService — query semantics

- `query` filters the full pinned order — rows never fetched in any window can match.
- Two OR'd, case-insensitive substring tiers. Folder tier matches display name (persona name if present, else folder name), name, path, tags, returning rows without `matchedSessionIds`. Session tier matches session `name`/`firstMessage`, returning `matchedSessionIds` with just the matched session ids.
- Filter then slice: `total` is the post-filter count; the window is `[offset, offset+limit)` of the filtered order.
- `includeArchived` defaults to false (archived rows excluded from rows and total); `true` includes them in both.

#### FolderListingService — session-derived metadata cache

- `pin()` and `query()` never block on a full session scan.
- Stale-while-revalidate: once the TTL (30s) lapses, the previous snapshot is served while the refresh runs in the background; later calls see the refreshed metadata.
- `invalidateSessionMetadata()` makes the next pin/query pick up fresh session metadata without waiting for the TTL.

#### FolderListingService — epochs and deltas

- `buildDelta` re-resolves the touched rows (full `FolderInfo` + live-session count enrichment) and passes `removedPaths` through.
- `buildDelta` serves current row data, not rows snapshotted at pin time.
- Every emitted delta bumps the monotonic epoch; `pin()` and `query()` stamp the epoch observed at computation time.

#### SessionSummaryIndex.listMany

- Returns summaries keyed by folder path across many folders in one pass (same summaries as the per-folder listing).
- Folders without a session directory contribute an empty list.

#### list_folders wire serving (ws-handler)

- The `list_folders` case delegates to the listing service with the raw window params (`orderToken`/`offset`/`limit`/`query`/`includeArchived`) and maps rows → `folders`, plus `roots`, `total`, `orderToken`, `more`, onto the response.

#### folders_changed delta emission (ws-handler + createServer wiring)

- `broadcastFoldersChanged` sends exactly the service-built delta to every connected client; the mutation site (`create_folder`) reports exactly the path it created.
- Registry mutations and repo-index refreshes route through the same delta channel to every client.

#### FolderStore — windowed fetching

- `ensureLoaded` fetches the first window under a fresh pin (no `orderToken` sent) and adopts the returned `orderToken` for continuation windows.
- `fetchNextWindow` fetches the next offset window under the adopted pin and merges rows by canonical path — a mid-scroll re-pin cannot duplicate rows.
- `fetchNextWindow` makes no request once the last window reported `more=false`.
- `search` is debounced (250ms): rapid calls coalesce into one offset-0 query fetch; server-authoritative matches merge into the cache, including rows outside the fetched set.
- With a query active, `fetchNextWindow` continues fetching match windows for that query.

#### FolderStore — folders_changed deltas

- Deltas merge `changed` rows by canonical path and drop `removedPaths` from the cache.
- A delta does not wipe live session indicators (sessions map preserved; enriched row counts applied).
- A delta arriving during an in-flight window load makes the older response stale: it is discarded and overwrites nothing.

Unchanged and already pinned by pre-existing tests: session-event row updates (state/rename/delete/archive), `visibleFolders` live re-sort (favorite → recency → name), per-folder `loadSessions` single-flight/reconciliation, and the unwindowed complete-list manager seam (`pimote_list_folders`).

Out of test scope: `FolderList` virtualization and the "loadSessions for rendered rows only" call discipline are rendering-layer concerns (`@tanstack/svelte-virtual`) with no stable non-visual seam yet.

### Notes on the plan

- **SDK `FolderInfo` twin (plan/codebase mismatch):** `packages/sdk` has no `FolderInfo` type — only `RepoInfo`/source-entry twins guarded by `server/src/sdk-twins.ts` — because folder sources contribute source entries, never wire rows. Per orchestrator decision the SDK change is skipped and `matchedSessionIds?` lives only on `shared/src/protocol.ts`'s `FolderInfo`; the plan line should be corrected.
- **`buildDelta` is typed async** (`Promise<FoldersChangedEvent>`): row re-resolution goes through the async registry listing, and the module contract forbids caching scan rows in the service.
- **Delta path threading is partially placeholder:** `create_folder`/`file_put` pass the paths they touch, but `folderRegistry.onChange` and `repoIndex.setOnRefreshed` do not yet carry changed/removed paths (the registry must report its mutation targets), so `server.ts` currently passes empty path lists into `broadcastFoldersChanged`.
