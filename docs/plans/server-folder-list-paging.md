# Plan: Server-side folder listing — pinned order, windowed fetch, server-side search

## Context

A folder source (SDK extension) contributes ~3.5k folders and the dashboard lags: `list_folders` ships every row, the client fires `list_sessions` per folder for the recency sort and chips, `folders_changed` rebroadcasts the full list, and every row renders. This makes folder listing server-driven: one pinned order per connection, offset/limit windows fetched on infinite scroll, two-tier search computed server-side, virtualized rendering on the client. See `docs/brainstorms/server-folder-list-paging.md` for the exploration and the reasoning behind the settled decisions (pinned order, same sort logic server-side, delta `folders_changed`, wire epoch, hard cut for old clients).

## Architecture

### Impacted Modules

- **Protocol** (`shared/src/protocol.ts`) — `ListFoldersCommand` gains optional `offset`/`limit`/`query`/`includeArchived`/`orderToken`/`repin`; `ListFoldersResponseData` gains `total`/`orderToken`/`more`/`epoch`; `FoldersChangedEvent` changes from a full-list broadcast to a delta (`changed` rows, `removedPaths`, `epoch`); `FolderInfo` gains optional `matchedSessionIds` and `repo?: RepoInfo` for its own git facts.
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
  orderToken?: string; // omitted → use the connection's pin; see repin
  repin?: boolean; // explicit refresh: pin a fresh order and return its token
}
interface ListFoldersResponseData {
  folders: FolderInfo[]; // rows may carry matchedSessionIds?: string[]
  roots: string[];
  total: number; // matches under query + includeArchived, over the whole set
  orderToken: string; // token this window was served under (client adopts it)
  epoch: number; // epoch observed at computation time (stale-response guard)
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
  pin(connectionId?: string): Promise<{ token: string; epoch: number }>;
  releaseConnection(connectionId: string): void;
  /** Serve one window under a pin. Raw params; normalization is internal:
   *  offset defaults 0, limit defaults 100, clamped to [1, 200]. */
  query(req: { connectionId?: string; token?: string; offset?: number; limit?: number; query?: string; includeArchived?: boolean; repin?: boolean }): Promise<{
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
- **Pin lifecycle.** Pins are per-connection and owner-scoped: pinned at WebSocket open when folder deps are available (async, nonblocking — a folder command arriving before pin completion awaits it), otherwise at first folder command; omitted-token commands reuse the connection's pin; `repin: true` (the client's explicit-refresh path) pins a fresh order and returns its token. A `releaseConnection` seam frees pins on close, plus a TTL sweep for orphans. Rows merge by canonical path client-side, so a mid-scroll re-pin cannot duplicate.
- **Query semantics.** `query` filters the full pinned order — never loaded rows only. Two tiers, OR'd: folder tier matches display name (persona name if present, else folder name), name, path, tags; session tier matches session `name`/`firstMessage`. A folder-tier match returns the row without `matchedSessionIds` (all its sessions shown, matching today's behavior); session-tier-only matches return `matchedSessionIds` with just the matched session ids. Filter then slice: `total` is the post-filter count over the whole set; the window is `[offset, offset+limit)` of the filtered order.
- **Session-derived metadata cache.** One server-wide cache (`folder → lastActivity` as `max(session.modified)`, `folder → session search text`) fed by a batched pass over `SessionSummaryIndex.list()` for all known folder paths, which itself caches per-file parses by mtime+size. `lastActivity` folds in live in-memory sessions at pin/query time, so actively-running folders rank as most-recent regardless of file-flush cadence. **Error contract:** a refresh failure never fails `pin()`/`query()` — serve the last good snapshot (empty-activity, name-only ordering on a truly cold cache) and recover on the next TTL/event refresh. Cold starts serve the previous snapshot while refreshing in the background — `pin()` and `query()` never block on a full 3.5k-folder scan. Invalidated by session events (rename, delete, archive toggle, state change) and by a TTL (default 30s, aligned with the repo-index TTL).
- **Epoch.** One monotonic counter, bumped whenever a `FoldersChangedEvent` is emitted. `query()` stamps responses with the epoch observed at computation time; the client discards a response whose epoch is older than the newest event it has seen and applies fresh ones regardless of interleaving.
- **Deltas.** Each mutation site reports the paths it touched; `buildDelta` re-resolves those rows (full `FolderInfo` + session-count enrichment) and returns the event with `changed`/`removedPaths` and the bumped epoch. ws-handler only sends it. Registry `onChange` and repo-index `setOnRefreshed` callbacks carry `{ changedPaths, removedPaths }` payloads so discovery additions/removals and registry edits forward their targets — no diffing machinery, no empty placeholder paths.
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
  visibleSessions(path: string): SessionInfo[]; // narrows session-only query matches
}
```

- The view sorts the fetched subset live (favorite → recency → name, as today) — driven by the client's open/bound-session state and whatever session data it has already loaded; sorting never triggers a session fetch. Server windows are fetched in pinned order.
- Search results are server-authoritative: with a query active, the view shows the rows the server returned for that query (folder-tier matches with all their sessions; session-tier matches with `matchedSessionIds` narrowing the lazy-loaded session list). Scroll under an active query fetches further match windows.
- `folders_changed` merges `changed` rows and drops `removedPaths` from the cache; rows sorting past the fetched frontier sit in cache and appear when scrolled to.
- Virtualizer supplies the visible range; `loadSessions` runs for rendered rows in the fetched set and never for the whole set. The open/bound-session restore path loads its sessions eagerly on startup, independent of window fetches.

### Planning Clarifications (approved by orchestrator)

- **Cached tree seam:** `RepoIndex.tree(): Promise<SparseTree>` exposes the discovery walk already cached by the repo-index adapter. `ListingStamp` retains that tree. `server/src/index.ts` routes `folderTree.tree` through it, replacing the raw scan per request. Tree and repo consumers share discovery, invalidation, and stale-while-revalidate TTL behavior. Manager tree consumers accept trees up to one TTL old. The scanner stays uncached.
- **Delta reconciliation:** callbacks report primary paths and derived dependents. `buildDelta` reconciles every touched path against current registry rows. A removed path that still resolves becomes `changed`, including `missing: true` source or registry rows. A changed path that no longer resolves becomes `removedPaths`. Untouched rows remain unchanged. Discovery callbacks can report physical disappearance while complete listings retain missing source rows.
- **Derived dependents:** member-tag changes also touch hubs whose inherited tags change. Discovery changes to member git facts, existence, or membership also touch dependent hubs. Registry membership supplies these targets without full folder-row diff machinery.
- **Own git facts:** `FolderInfo.repo?: RepoInfo` carries the row's own repo facts for plain code rows known to the index. Personas omit it. Existing `repos?: RepoInfo[]` remains the hub membership list and disband gate. Registry construction copies cached repo facts, without new git probes. Dashboard rows no longer depend on `list_repos`. The hub picker still requests that complete listing explicitly.
- **Archive filtering:** changing `showArchived` reloads session lists already present in the sessions map. Other rows load sessions only when rendered callers request them. Once folder pagination exists, the toggle also requests an offset-0 folder window with the new `includeArchived` value. Folder and session archive filters remain separate concerns. Do not add eager session enumeration for seeded caches without pins.
- **Mutable infrastructure:** the architecture already authorizes class-owned metadata snapshots, pins, epochs, and client cache/request state. Keep these inside injected module instances. Pure helpers receive rows, metadata, and query values explicitly. Add no module-global business state.

### Technology Choices

- **`@tanstack/svelte-virtual`** for list virtualization (user-selected). Rows are variable-height (chip rows; some expand to session lists), which is exactly its dynamic-measurement support; `svelte-virtual-list` was rejected as weak on variable heights, hand-rolled windowing as bespoke jank-fixing we'd maintain.
- No other new dependencies: offset/limit windowing, the metadata cache, and delta emission are plain TypeScript over the existing seams.

## Tests

**Pre-test-write commit:** `3f0f69329878de974b8f799eeba7ce8d6c702168`

### Interface Files

- `shared/src/protocol.ts` — wire additions: `ListFoldersCommand` gains `offset`/`limit`/`query`/`includeArchived`/`orderToken`/`repin`; `ListFoldersResponseData` gains `total`/`orderToken`/`more`/`epoch`; `FoldersChangedEvent` becomes a delta (`changed`, `removedPaths`, `epoch`); `FolderInfo` gains `matchedSessionIds?`.
- `server/src/folder-listing.ts` — `FolderListingService` (`pin`/`releaseConnection`/`query`/`buildDelta`/`invalidateSessionMetadata`), `FolderListing` stub, `FolderListingDeps` (registry row listing, batched session summaries, live sessions), `FolderPin`/`FolderQueryRequest`/`FolderQueryResult`.
- `server/src/session-summaries.ts` — `SessionSummaryIndex.listMany()` batch entry stub (cross-folder pass reusing the per-file cache).
- `server/src/ws-handler.ts` — `broadcastFoldersChanged` reshaped to the delta emitter (service-built delta, paths from mutation sites); `folderListing` added to the connection deps; `list_folders`/`create_folder`/`file_put` call sites rewired.
- `server/src/server.ts` — `createServer` takes `folderListing`; registry `onChange` and repo-index `setOnRefreshed` route through the delta emitter.
- `server/src/index.ts` — constructs `FolderListing` over the shared `SessionSummaryIndex`, the registry listing, and live sessions.
- `client/src/lib/stores/folder-store.svelte.ts` — `FolderStore` gains `fetchNextWindow()`/`search()`/`visibleSessions()` stubs; `applyFoldersChanged` reshaped to the delta contract (stub).
- `server/src/folder-registry.ts` and `server/src/repo-index.ts` — mutation and discovery callback interfaces carry changed/removed path payloads.

### Test Files

- `server/src/folder-listing.test.ts` — the folder listing service: order snapshot, pin lifecycle, windowing, two-tier search, metadata cache, epochs, delta construction.
- `server/src/session-summaries.test.ts` — adds `listMany()` batch listing (grouped by folder path; empty for folders without sessions).
- `server/src/ws-handler.test.ts` — `list_folders` window delegation/mapping; `broadcastFoldersChanged` sends the service-built delta to every client; `create_folder` names its created path in the delta.
- `server/src/server.test.ts` — registry-mutation and repo-index-refresh wiring delivers the service-built delta to every client.
- `client/src/lib/stores/folder-store.svelte.test.ts` — windowed fetching (pin adoption, next-window merge, more=false halt), debounced search, delta merge/drop, stale-response guard.
- `server/src/folder-registry.test.ts` — update/createHub/disbandHub mutation callback targets.
- `server/src/repo-index.test.ts` — discovery addition/removal callback targets.

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
- Invalidation schedules nonblocking refresh; completion affects fresh pins only, never reorders existing pins.
- Metadata refresh failures retain the last good snapshot (name-only order when cold) and recover on subsequent TTL/event refresh; registry failures propagate.
- Connection-owned pins reject cross-owner adoption and are released on close.

#### FolderListingService — epochs and deltas

- `buildDelta` re-resolves the touched rows (full `FolderInfo` + live-session count enrichment) and passes `removedPaths` through.
- `buildDelta` serves current row data, not rows snapshotted at pin time.
- Every emitted delta bumps the monotonic epoch; `pin()` and `query()` stamp the epoch observed at computation time.

#### SessionSummaryIndex.listMany

- Returns summaries keyed by folder path across many folders in one pass (same summaries as the per-folder listing).
- Folders without a session directory contribute an empty list.

#### list_folders wire serving (ws-handler)

- The `list_folders` case delegates to the listing service with the raw window params (`orderToken`/`offset`/`limit`/`query`/`includeArchived`) and maps rows → `folders`, plus `roots`, `total`, `orderToken`, `more`, `epoch`, onto the response.

#### folders_changed delta emission (ws-handler + createServer wiring)

- `broadcastFoldersChanged` sends exactly the service-built delta to every connected client; the mutation site (`create_folder`) reports exactly the path it created.
- Registry mutations and repo-index refreshes route through the same delta channel to every client.
- WebSocket rename/delete/archive/unarchive commands and server status/close callbacks invalidate session metadata for the affected folder. Existing session events continue without folder deltas.

#### FolderStore — windowed fetching

- `ensureLoaded` fetches the first window under the connection's open-time pin (no `orderToken` sent) and adopts the returned `orderToken` for continuation windows.
- The handler pins at connection open, awaits pending pins for early commands, reuses omitted-token queries, replaces pins on explicit refresh, and releases owned pins on close.
- `fetchNextWindow` fetches the next offset window under the adopted pin and merges rows by canonical path — a mid-scroll re-pin cannot duplicate rows.
- `fetchNextWindow` makes no request once the last window reported `more=false`.
- `search` is debounced (250ms): rapid calls coalesce into one offset-0 query fetch; server-authoritative matches merge into the cache, including rows outside the fetched set.
- With a query active, `fetchNextWindow` continues fetching match windows for that query.

#### FolderStore — folders_changed deltas

- Deltas merge `changed` rows by canonical path and drop `removedPaths` from the cache.
- A delta does not wipe live session indicators (sessions map preserved; enriched row counts applied).
- A response whose wire epoch is older than the newest delta is discarded; a fresh response computed after an interleaved delta is accepted.
- Folder/search fetches never enumerate session lists; visible-row callers explicitly invoke `loadSessions`.
- Search filters `visibleFolders` using server-authoritative matches while preserving the accumulating cache; `visibleSessions` narrows session-tier-only matches and leaves folder-tier matches unrestricted.
- Failed continuation/search requests preserve cached rows and allow retry; explicit refresh sends `repin: true`.

Unchanged and already pinned by pre-existing tests: session-event row updates (state/rename/delete/archive), `visibleFolders` live re-sort (favorite → recency → name), per-folder `loadSessions` single-flight/reconciliation, and the unwindowed complete-list manager seam (`pimote_list_folders`).

Out of test scope: `FolderList` virtualization and the "loadSessions for rendered rows only" call discipline are rendering-layer concerns (`@tanstack/svelte-virtual`) with no stable non-visual seam yet. The manager-archive metadata-invalidation call in `server/src/index.ts` is an approved integration exclusion: bootstrap has no isolated stable seam. Implementation must still invalidate that folder's metadata without a folder delta.

### Notes on the plan

- **SDK `FolderInfo` twin (plan/codebase mismatch):** `packages/sdk` has no `FolderInfo` type — only `RepoInfo`/source-entry twins guarded by `server/src/sdk-twins.ts` — because folder sources contribute source entries, never wire rows. Per orchestrator decision the SDK change is skipped and `matchedSessionIds?` lives only on `shared/src/protocol.ts`'s `FolderInfo`; the plan line should be corrected.
- **`buildDelta` is typed async** (`Promise<FoldersChangedEvent>`): row re-resolution goes through the async registry listing, and the module contract forbids caching scan rows in the service.
- **Review-approved interface corrections:** wire `epoch`, connection-owned `pin`/`releaseConnection`, `repin`, registry/discovery callback path payloads, and the client `visibleSessions` selector are materialized. Their behavior remains stubbed for implementation; callback emitters currently send empty placeholder paths. Tests require correct paths and forwarding.
- **Additional test files reviewed:** `server/src/folder-registry.test.ts` pins update/createHub/disbandHub mutation-path payloads; `server/src/repo-index.test.ts` pins discovery addition/removal payloads. Their interface files are `server/src/folder-registry.ts` and `server/src/repo-index.ts`.
- Registry `onChange` and repo-index `setOnRefreshed` callbacks carry `{ changedPaths: string[]; removedPaths: string[] }`; server wiring forwards these to delta construction.
- **Compatibility:** the user-approved hard cut supersedes the brainstorm's unwindowed-default compatibility proposal; Android breakage remains accepted.

### Authorized planning-phase test amendments

The orchestrator approved these narrow exceptions to immutable tests. Write each amendment red-first, then implement its behavior. Do not reopen test review or add unrelated coverage.

- `server/src/folder-listing.test.ts`: add both delta normalization directions. Missing retained rows become changes. Unresolvable changed paths become removals.
- `server/src/repo-index.test.ts`: add cached-tree coverage. Repeated tree/window reads reuse discovery. TTL-expired reads serve the previous tree during background refresh. Preserve invalidation behavior.
- `client/src/lib/stores/folder-store.svelte.test.ts`: correct the legacy `setShowArchived` eager-enumeration expectation. Seed one loaded session list and one unloaded folder. Assert reload only for the loaded list, then assert explicit `loadSessions` loads the other. Preserve preference persistence.
- `server/src/folder-registry.test.ts`: cover member-tag changes targeting the member and dependent hubs. Verify inherited hub tags against a fresh registry listing.

These amendments cover decisions resolved during planning, not new product scope. Existing tests remain unchanged otherwise.

**Review status:** approved

## Steps

### Step 1: Reuse the cached discovery tree

In `server/src/repo-index.test.ts`, add the authorized cached-tree tests red-first. Cover repeated reads, cold single-flight, TTL-stale serving, background replacement, and invalidation.

In `server/src/repo-index.ts`, retain `SparseTree` in `ListingStamp`. Add `tree(): Promise<SparseTree>` over the existing `discover()` lifecycle. `list()` and `tree()` must share the walk and generation guard. Warm tree reads must not rescan. Expired tree reads return the previous tree while refreshing. Invalidations discard the old tree with the listing.

In `server/src/index.ts`, construct `repoIndex` before `folderTree`. Route `folderTree.tree` to `repoIndex.tree()`. Keep the separate strict boot enumeration unchanged. It still calls `scanFolderModel` for its safety-critical allow-list.

Do not add scanner caching or cache scan rows inside `FolderListing`.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/repo-index.test.ts` passes the cache tests. Existing discovery, missing-row, and invalidation tests remain green. Repeated registry listings share a walk through the wired tree port.
**Status:** not started

### Step 2: Put own repo facts on folder rows

In `shared/src/protocol.ts`, add `repo?: RepoInfo` to `FolderInfo`. Document own repo facts separately from hub `repos`. Preserve the already-materialized window, epoch, delta, refresh, and search interfaces. Do not add an SDK `FolderInfo` twin.

In `server/src/folder-registry.ts`, update `mergedFolders` to populate `repo` for plain code rows with an indexed repo. Persona rows omit it. Hub `repos` retains its current membership and disband meaning. Copy current cached repo facts into the returned row. Add no git probes.

Keep registry curation and full-list interfaces unchanged. This step changes row enrichment, not query ownership.

**Verify:** `npm run build:shared` succeeds. Existing folder registry and SDK-twin tests pass. Plain code rows expose their git facts without a separate client repo listing. Persona rows expose no own repo facts.
**Status:** not started

### Step 3: Implement batched session summaries

In `server/src/session-summaries.ts`, implement `SessionSummaryIndex.listMany(folderPaths)` with its existing `Map<string, SessionSummary[]>` result. Reuse `list()` and its per-file cache and folder single-flight. Bound cross-folder work using the existing concurrency helper. Empty inputs return an empty map. Missing directories contribute empty arrays.

Preserve the existing per-folder summary ordering, parse error behavior, and mtime-plus-size cache. Do not create a second file parser or cache.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/session-summaries.test.ts` passes batch, missing-directory, cache-identity, and existing parsing tests.
**Status:** not started

### Step 4: Implement metadata snapshots and owned pins

In `server/src/folder-listing.ts`, implement the class-owned session metadata snapshot and `pin`/`releaseConnection`. Refresh metadata through injected `listRows`, `sessionSummaries.listMany`, and `listLiveSessions` dependencies. Keep the last successful metadata snapshot during refresh. Use the default 30-second TTL and a single in-flight refresh. Invalidations during refresh must remain eligible for a later refresh.

Implement `invalidateSessionMetadata(folderPaths?)` as nonblocking invalidation for named folders or all folders. Refresh failure retains the previous snapshot. Cold metadata failures retain empty activity and folder-only search. Registry failures from public operations propagate.

Pins contain canonical paths only. Order fresh pins by favorite, activity, name, then path. Compute disk activity from maximum `SessionSummary.modified`. Fold live sessions into fresh ordering without waiting for disk writes. Do not await the batched scan from `pin()` or `query()`.

Scope tokens to their connection owner. Omitted-token connection requests reuse the owner's pin. Standalone requests without tokens create fresh pins. Unknown, expired, or cross-owner tokens create a replacement. Explicit refresh replaces the connection pin. Release all owned pins on close, including pins whose registry read finishes after release. Sweep expired orphan tokens without adding a new public configuration interface.

Use pure private helpers for metadata projection and comparison. Keep cache and lifecycle mutation inside `FolderListing`.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/folder-listing.test.ts` passes order, ownership, release-during-pending-pin, and metadata tests as query implementation lands in Step 5. Hanging scans do not delay pins. Existing tokens retain their order after refresh.
**Status:** not started

### Step 5: Serve filtered windows and reconciled deltas

First add the authorized normalization tests in `server/src/folder-listing.test.ts`. Cover a removed source row still present with `missing: true`, and a changed path absent from current rows.

In `server/src/folder-listing.ts`, implement `query(req)` over the selected pin. Resolve current rows from the registry for every request. Drop absent paths without changing the pin. Apply archive and two-tier query filters over the full pinned order, then slice. Normalize offset and limit internally, with defaults 0 and 100 and limit clamped to [1, 200]. Return post-filter `total`, `more`, adopted `orderToken`, and computation-time `epoch`.

Folder-tier matching uses persona display name, name, path, and tags. Session-tier matching uses cached names and first messages. Folder matches omit `matchedSessionIds`, even when sessions also match. Session-only matches carry matched ids. Never persist query annotations into registry rows or shared metadata.

Implement `buildDelta(changedPaths, removedPaths)` against current registry rows. Reconcile and deduplicate touched paths. Existing rows go into `changed`. Absent rows go into `removedPaths`. Return copied, fully populated rows enriched with live session counts. Preserve own and member repo facts. Bump the shared epoch once per successful delta. Stamp query epochs before asynchronous row computation can overlap a later delta, so old computations cannot claim a newer epoch.

Reuse `enrichActiveSessionCounts` from `server/src/folder-registry.ts` on copied response rows. Never mutate registry-owned rows or snapshot row objects.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/folder-listing.test.ts` passes all service tests, including normalization. Queries preserve pinned order while returning current curation. Deltas and full current listings agree for every touched path.
**Status:** not started

### Step 6: Emit exact mutation and discovery targets

First add the authorized dependent-hub tag tests in `server/src/folder-registry.test.ts`. Compare emitted member and hub rows with a fresh listing.

In `server/src/folder-registry.ts`, change private `fireChange` to accept changed and removed paths. `update` reports its canonical primary path. Tag updates also report registry and source hubs whose inherited tags depend on that member. `createHub` reports `canonicalTarget`. `disbandHub` reports its removed hub path. Emit after successful persistence, never for rejected mutations.

In `server/src/repo-index.ts`, replace empty refresh callback targets with concrete paths. Use the retained discovery tree and source entries to identify discovery additions, changes, and removals. Include persona paths, source hubs, and changed git facts, not only code-repo additions. Exclude timestamps and stale status-cache entries from change targets. Preserve the existing unchanged-refresh silence and physical-disappearance callback expectation.

Include dependent hub paths when refreshed member facts or membership change their rows. Use known shortcut/source membership, not full registry-row diffing. Keep missing source rows in complete repo listings. Step 5 reconciles physical-removal notifications against retained registry rows.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/folder-registry.test.ts src/repo-index.test.ts` passes mutation payload and refresh tests. Member tag changes update inherited hub tags. Unchanged refreshes emit nothing, and notifications contain no placeholder paths.
**Status:** not started

### Step 7: Wire windows, deltas, and metadata invalidation

In `server/src/ws-handler.ts`, implement open-time nonblocking pin initialization when listing and folder dependencies exist. Early folder commands await the pending pin. Retry failed initialization through the command error path without unhandled rejections. Track the adopted token per handler. Explicit refresh requests call `pin(clientId)` once, then query under the replacement. `cleanup()` calls `releaseConnection(clientId)` without retaining a late pin.

Replace `list_folders` registry listing with raw-param delegation to `FolderListingService.query`. Forward connection id, adopted or explicit token, offset, limit, query, archive flag, and refresh intent. Map `rows` to wire `folders`, and return roots plus every window field. Preserve error responses. Keep `list_repos` and manager complete-list consumers unwindowed.

Implement static `broadcastFoldersChanged` as asynchronous service-built delta sending to each registered client. Handle construction failures without unhandled rejections. Do not rebuild or alter the returned event. `create_folder` already supplies its created path. Registry subscriptions own update/createHub/disbandHub emissions, so add no duplicate command broadcasts.

For `file_put`, translate an edited `AGENTS.md` file path to the containing canonical folder path before delta construction. A file path is not a folder key. Preserve file-write response behavior.

Invalidate targeted metadata after successful rename, delete, archive, and unarchive operations. Preserve existing session events without folder deltas. In `server/src/server.ts`, invalidate metadata from status and close callbacks. Forward registry and repo-index callback payloads unchanged to the delta emitter.

In `server/src/index.ts`, retain the existing shared summary-index construction and listing injection. Add targeted metadata invalidation to the successful manager archive path, including archive operations without a live slot. Send no folder delta for session activity.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/ws-handler.test.ts src/server.test.ts` passes delegation, pin lifecycle, mutation wiring, and targeted invalidation tests. Each registry mutation emits one delta channel. Session-only changes emit existing session events only.
**Status:** not started

### Step 8: Accumulate client windows and authoritative search

In `client/src/lib/stores/folder-store.svelte.ts`, implement path-keyed row accumulation while preserving public `folders` reads and assignments used by callers and tests. Add class-owned pagination state for token, response offset, total, more, active query, and query match paths. Track request context separately from row count. Overlapping replacement-token windows must not duplicate rows or corrupt the next offset.

Make `ensureLoaded` request one initial window per connection without an `orderToken` or `repin`. Adopt its token after an accepted response. Keep `loadFolders` as explicit refresh with `repin: true` after a successful initial load. Implement single-flight `fetchNextWindow` with the current token and query. Stop when `more` is false. Failed or stale requests preserve cache and continuation position for retry.

Implement `search` with a 250ms debounce. Coalesced callers must settle. Each new query starts at offset 0, adopts the response token, and merges rows without clearing accumulated nonmatches. Guard request context so a superseded query or closed connection cannot replace current search state. Empty query restores the accumulated unfiltered view. Scroll under a query continues its match windows.

Use response wire epochs, not local request-start counters. Discard responses older than the newest delta. Accept equally new responses computed after interleaved events. Reset connection-specific token, pending request context, and epoch guard on disconnect while retaining useful cached rows.

Implement `applyFoldersChanged` to merge changed rows and remove absent paths without wiping the sessions map. Implement `visibleFolders` using server-authoritative query match paths plus archive filtering and existing live favorite/recency/name sorting. Implement `visibleSessions` with active-query `matchedSessionIds`, unrestricted for folder-tier matches and cleared queries.

Remove `loadFolders` session fan-out and eager `loadRepos`. `loadRepos` remains explicit for creation/member flows. Keep existing session-list single-flight, event reconciliation, and structural epoch handling intact.

**Verify:** `npm run test --workspace=client -- --run src/lib/stores/folder-store.svelte.test.ts` passes window, debounce, query-view, epoch, retry, and existing session tests except the authorized archive-toggle correction completed in Step 9. Folder fetches issue no `list_sessions` or dashboard `list_repos` enumeration.
**Status:** not started

### Step 9: Separate archive-filter reloads from window loading

Correct the authorized archive-toggle test red-first in `client/src/lib/stores/folder-store.svelte.test.ts`. Seed a loaded session-map path and an unloaded folder path. Require a reload only for the loaded path. Require explicit `loadSessions` for the other path. Preserve preference round-trip assertions.

In `client/src/lib/stores/folder-store.svelte.ts`, update `setShowArchived` to persist the flag and reload session-map paths whose displayed lists use it. Do not iterate all cached folders to discover sessions. If pagination exists, request an offset-0 folder window with the current query, pin, and new archive flag. Merge accepted rows and reset that filtered continuation state. Keep connection pins stable unless the user explicitly refreshes.

**Verify:** The complete `folder-store.svelte.test.ts` suite passes. An archive toggle fetches no sessions for unloaded cached rows. Established folder pagination can include archived folders without discarding live session state.
**Status:** not started

### Step 10: Virtualize rows and load rendered sessions

Install the selected dependency with `npm install @tanstack/svelte-virtual --workspace=client`. Let npm update manifests and the lockfile. Do not edit dependency files manually.

In `client/src/lib/components/Dashboard.svelte`, expose its existing scrolling element to `FolderList`. Preserve its swipe-card close listener and desktop/mobile layout. In `client/src/lib/components/FolderList.svelte`, use that scroll element and the list's offset within it for the TanStack virtualizer. Use canonical paths as item keys, measured variable row heights, and correct total-height spacing. Measure changes from session expansion, tags, and subtitles.

Replace local `searchResults` folder/session scanning with `folderStore.search(search)`, `visibleFolders`, and `visibleSessions`. Render only virtual items. Trigger `fetchNextWindow` near the fetched view's end, including query results. Invoke `loadSessions` only for rendered rows needing a list, with bookkeeping that avoids a load loop when responses change measurements. Do not call it for every fetched row.

Render plain-row git badges from `folder.repo`. Keep hub badges and disband checks based on `folder.repos`. Preserve row icons, half-open session filtering, menus, tag editing, and expanded-session controls. Use response `total` for the folder count rather than accumulated cache size.

Preserve startup session hydration in `client/src/lib/stores/session-registry.svelte.ts`. Its persisted open/bound sessions restore without awaiting folder windows. Feed those restored session facts into the fetched subset's live recency view without triggering folder-wide session enumeration. Keep full repo requests explicit in the hub picker.

**Verify:** `npm run check --workspace=client` and `npm run build --workspace=client` succeed. With approximately 3,500 folders, DOM row count remains bounded. Scrolling fetches more windows. Expanding rows does not overlap following rows. Search finds unfetched folders and narrows session-only matches. Restored chat sessions remain usable before folder fetching completes.
**Status:** not started

### Step 11: Align smoke journeys and verify the full slice

In `tools/manual-test/project-management-smoke/project-management-smoke.mjs`, adapt probes to accumulate protocol windows under adopted tokens where a complete comparison is necessary. Pass `includeArchived` explicitly for archived-row checks. Explicitly repin after discovery mutations when testing a fresh order. Replace `event.folders` predicates with `changed` and `removedPaths` assertions. Preserve manager complete-list expectations.

Adapt browser row lookup to scroll virtualized content before selecting offscreen folders. Preserve existing structural, curation, hub, fallback-session, and reconnect journeys. Update `tools/manual-test/PLAN.md` and `tools/manual-test/README.md` to describe window adoption, delta sync, server-authoritative search, and bounded rendering.

Update `codemap.md` for the new listing module, cached-tree accessor, row repo enrichment, accumulating store, and virtualization. Note the accepted Android protocol break. Do not implement an Android compatibility layer or SDK row twin.

Run targeted suites, then all server and client tests. Run shared build, project checks, lint, and production build. Exercise the existing dashboard/folder smoke driver from its documented command. If checks fail, fix implementation or report a concrete blocker. Do not bypass hooks or broaden the authorized test amendments.

**Verify:** `npm run build:shared`, `npm run test --workspace=@pimote/server -- --run`, `npm run test --workspace=client -- --run`, `npm run check`, `npm run lint`, and `npm run build` pass. Updated smoke journeys validate both clients against deltas and fresh windows. No per-folder fan-out occurs before rendered-row requests.
**Status:** not started
