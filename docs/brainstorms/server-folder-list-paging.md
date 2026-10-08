# Server-side folder listing: paged fetch, server sort/search, infinite scroll

**Date:** 2026-10-08
**Pull:** `server-folder-list-paging` (PM brief: `../product-manager/pulls/server-folder-list-paging.md`)

## The idea

A folder source (SDK extension) contributes ~3.5k folders to the folder model and the dashboard lags badly. Move folder listing to a server-driven, windowed fetch — server-side sorting and search, top-N style requests — so the client only ever holds and renders what it needs. Client list virtualization is the instinctive render-side complement.

## What we learned before deciding

Three independent lag sources exist today, and any fix that touches only one of them leaves the others:

1. **Transfer + store** — `list_folders` ships the entire merged list (all folder-source rows plus registry curation) and `folders_changed` rebroadcasts the _entire enriched list_ to every client on any registry mutation. At 3.5k rows that broadcast is itself a scalability problem.
2. **Session fan-out** — after `list_folders` the client fires `list_sessions` per folder (3.5k round-trips) to compute the recency sort key and session chips. This is likely the dominant cost.
3. **Rendering** — every row is a live component with chips; 3.5k of them in the DOM lags.

Windowed fetches fix 1 and 2; virtualization fixes 3. All three matter; the pull covers the first two plus the fetch protocol, virtualization is the client render layer for whatever has been accumulated.

Premise correction: no paging exists anywhere today (the PM's premise check). This _introduces_ windowed listing; nothing is "moved" from client to server except sort and search computation.

## Key decisions

- **Server-side sorting, same logic as today**: favorites first → session recency → name. _Why:_ dropping recency would visibly regress the dashboard; the server already aggregates sessions per folder (`enrichActiveSessionCounts`), so fold in last-activity rather than change the ordering contract.
- **Server-side search over the full set, both tiers**: folder fields (name, tags, persona) and session `name`/`firstMessage`. _Why:_ search must not silently degrade to loaded-rows-only — with 3.5k folders most rows are never fetched, and matching only what's cached would make search lie.
- **Offset/limit windows** (PM call, adopted). _Why:_ at this scale server-side sort + offset slicing is cheap; offsets give page jumps and totals; cursor stability buys little when the client refetches windows on invalidation anyway.
- **Server pins the sort order at WebSocket open.** Offset windows reference that pinned order for the life of the connection. _Why:_ recency is a mutable sort key — with free-running offsets, rows duplicate or vanish across page boundaries as activity changes. A connection-scoped pin gives stable pagination while the client stays free to re-sort what it holds.
- **Client cache accumulates by canonical path.** Scrolling appends the next window; a search fetch merges its matching subset into the same cache (the view filters/sorts locally; the cache only grows). The client re-sorts the fetched subset live as session activity updates land. _Why:_ matches today's live-reorder feel on what you can see, without server round-trips per activity change.
- **Pin lifetime: connection-scoped.** New or changed folders arrive via `folders_changed` and merge into the cached set, sorted into place; a row that sorts past the fetched frontier is appended at the end. The pin re-rolls on reconnect or explicit refresh. _Why:_ forced re-pins on every mutation would recreate the instability the pin exists to avoid; "good enough" per Alenna.
- **`folders_changed` becomes an invalidation signal**, not a full-list broadcast. _Why:_ the full-list broadcast is itself the scalability problem at this scale. The existing epoch guard on the client stays: responses taken before an invalidation are discarded.
- **Infinite scroll, not page controls.** The client requests more as the viewport nears the end of the accumulated set. _Why:_ Alenna's stated interaction; "top-N as you go" is the whole point.
- **Virtualization + lazy session chips on the client.** Only visible rows render; session chips (and their `list_sessions` fetch) load per visible row. _Why:_ kills the 3.5k session fan-out and the 3.5k-component DOM.

## Open questions

**Sharp — inputs to architecting:**

- Recency sort key source. Today's recency is `max(modified)` over a folder's sessions as returned by per-folder `list_sessions`. The server-side sort needs that across all folders _without_ scanning session files per request — does a global session metadata index exist or need building? (Feasibility gate for the "same sorting logic" decision.)
- Same question for the session-tier search (`name`/`firstMessage` matching across all folders per keystroke) — needs an index or a cheap enumeration, plus debounce expectations.
- Shape of the pinned order: an ordered path array snapshotted at connection open vs. sort-key snapshot + server-side sort per window. Cost differs if folder sources take long to enumerate.
- What replaces the full-list `folders_changed` payload (changed paths + epoch? tombstones for removed rows?), and which mutations trigger it (registry curation, source refresh, folder creation/disband, session activity for chips).
- Protocol compatibility: `ListFoldersCommand` gains optional `offset`/`limit`/`query` (and response gains `total`/pin info) — older clients (mobile, SDK consumers) must keep working against the unwindowed default.
- Cost of building a window per request: the merged scan + registry listing currently rebuilds wholesale; windowed serving still needs the full ordered list to slice — check repo-index caching so we don't re-enumerate folder sources per fetch.

**Fog:**

- Long-lived connections: a stale pin plus lazy fetching can hide recently-active folders behind the fetched frontier — sensed risk, not yet a precise question. May become "add a lightweight re-pin affordance" later.
- Whether other `FolderInfo` consumers (the manager tool `pimote_list_folders`, hub member management) want windows too. Current instinct: no — they want the complete list; leave them unwindowed.
