# Plan: Server-side folder listing — pinned order, windowed fetch, server-side search

## Context

A folder source (SDK extension) contributes ~3.5k folders and the dashboard lags: `list_folders` ships every row, the client fires `list_sessions` per folder for the recency sort and chips, `folders_changed` rebroadcasts the full list, and every row renders. This makes folder listing server-driven: one pinned order per connection, offset/limit windows fetched on infinite scroll, two-tier search computed server-side, virtualized rendering on the client. See `docs/brainstorms/server-folder-list-paging.md` for the exploration and the reasoning behind the settled decisions (pinned order, same sort logic server-side, delta `folders_changed`, wire epoch, hard cut for old clients).

## Architecture

### Impacted Modules

- **Protocol** (`shared/src/protocol.ts`) — `ListFoldersCommand` gains optional `offset`/`limit`/`query`/`includeArchived`/`orderToken`; `ListFoldersResponseData` gains `total`/`orderToken`/`more`; `FoldersChangedEvent` changes from a full-list broadcast to a delta (`changed` rows, `removedPaths`, `epoch`); `FolderInfo` gains optional `matchedSessionIds`.
- **Server** — new `folder-listing.ts` module (below) owns ordering, search, and windowing. `ws-handler.ts` `list_folders` case shrinks to parse → `folderListing.query(...)` → respond; `broadcastFoldersChanged` becomes a delta emitter where each mutation site (`update_folder`, `create_folder`, `disband_hub`, registry `onChange`) knows exactly which paths changed. `folder-registry.ts` stays the curation-persistence owner; it gains no query logic. `session-summaries.ts` gains a batch listing entry so a cross-folder pass reuses its per-file cache.
- **Web Client** — `FolderStore` becomes a path-keyed accumulating cache over a pinned order (fetch-next-window, search-merge, epoch guard, live re-sort of the fetched subset); `FolderList.svelte` renders the accumulated set through a virtualizer. Per-folder session _lists_ load only for rows in the fetched set as they render (replacing today's fan-out over every folder); folder-row session/git indicators come from server enrichment in the row payload, never from client enumeration. Vocabulary: "chips" in this project means the chat view's open/bound-session buttons — a client-local concern (persisted in local storage, restored eagerly at startup) that is fully independent of folder listing; it feeds the live re-sort and never waits on window fetches.
- **SDK** — `FolderInfo` twin (`sdk-twins.ts`-guarded) gains `matchedSessionIds?`; folder-source seam (`FolderSource.list()`) is unchanged.
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
  /** Serve one window under a pin. */
  query(req: { token?: string; offset: number; limit: number; query?: string; includeArchived?: boolean }): Promise<{
    rows: FolderInfo[];
    total: number;
    more: boolean;
    orderToken: string;
    epoch: number;
  }>;
}
```

Behavioral contracts:

- **Order snapshot.** A pin is an ordered array of canonical folder paths, snapshotted from the rows and session-derived metadata at `pin()` time: `favorite desc → lastActivity desc → name asc → path asc` (path is the deterministic tiebreak stable pagination needs; today's contract is favorite → recency → name). The pin holds _order only_ — row data is re-resolved from the registry at query time, so curation edits are never stale against an old pin.
- **Pin lifecycle.** Pins live for the connection; garbage-collected when the connection closes (plus a TTL sweep for orphaned tokens). A query with an unknown/expired token transparently re-pins and serves the window under the new token (returned in `orderToken`; the client adopts it). Rows merge by canonical path client-side, so a mid-scroll re-pin cannot duplicate.
- **Query semantics.** `query` filters the full pinned order — never loaded rows only. Two tiers, OR'd: folder tier matches display name (persona name if present, else folder name), name, path, tags; session tier matches session `name`/`firstMessage`. A folder-tier match returns the row without `matchedSessionIds` (all its sessions shown, matching today's behavior); session-tier-only matches return `matchedSessionIds` with just the matched session ids. Filter then slice: `total` is the post-filter count over the whole set; the window is `[offset, offset+limit)` of the filtered order.
- **Session-derived metadata cache.** One server-wide cache (`folder → lastActivity` as `max(session.modified)`, `folder → session search text`) fed by a batched pass over `SessionSummaryIndex.list()` for all known folder paths, which itself caches per-file parses by mtime+size. `lastActivity` folds in live in-memory sessions at pin/query time, so actively-running folders rank as most-recent regardless of file-flush cadence. Cold starts serve the previous snapshot while refreshing in the background — `pin()` and `query()` never block on a full 3.5k-folder scan. Invalidated by session events (rename, delete, archive toggle, state change) and by a TTL (default 30s, aligned with the repo-index TTL).
- **Epoch.** One monotonic counter, bumped whenever a `FoldersChangedEvent` is emitted. `query()` stamps responses with the epoch observed at computation time; the client discards a response whose epoch is older than the newest event it has seen and applies fresh ones regardless of interleaving.
- **Deltas.** Each mutation site reports the paths it touched; the emitter re-resolves those rows (full `FolderInfo` + session-count enrichment) and sends them in `changed`, with `removedPaths` for deletions/disbands. No diffing machinery: mutations know their targets.
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
