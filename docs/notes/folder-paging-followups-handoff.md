# Handoff: folder-paging follow-ups

Two deferred follow-ups from `server-folder-list-paging` (shipped 2026-10-09; DR-055–058 record the decisions and the deferred items). Tackle each in its own session. Read DR-055 and DR-058 first — this file assumes them.

## 1. Keyset/offset-correction (kills the offset-skip bug class)

Recorded in DR-055's consequences as the permanent fix for a class of bugs we patched around.

### The problem

Windows are numeric slices: `offset`/`limit` into the pinned order, filtered by query/includeArchived. When a row **above** the fetched frontier leaves the filtered order mid-scroll (archived, removed, or a session-tier search match evaporating via session metadata), every row below shifts up one position. The next continuation window starts at the stale offset and skips one row silently.

Mitigations shipped (client `FolderStore`): scan restarts at 0 when (a) a delta removes/hides rows inside the fetched prefix, (b) a continuation response reports a smaller `total` than the previous response of the same scan, (c) a session delete/rename strips the _sole_ session-tier match of a fetched row. **Remaining hole — net-zero shrink:** one match leaves and a different one enters between two windows. `total` is unchanged, no delta fires (session events don't emit `folders_changed`), yet positions shifted: a row can still be skipped. Accepted residual; recorded in DR-055.

### The fix direction

Stop counting, start naming: continuation windows should resume **after a cursor** — the last row's sort key (or canonical path) from the previous window — instead of after a numeric offset. `offset=0` (first window, refresh, repin, search-context changes) keeps working as today; only continuations become keyset.

- Skips become impossible by construction: removals/insertions above the cursor can't move a content-named position.
- The restart tripwires can then be simplified — they exist to patch offset drift.
- `total` and page jumps are orthogonal (server computes totals over the filtered set anyway).

### Design decisions to make in-session

- Cursor contents: `(lastActivity, name, path)` triple vs. path-only (path-only needs the server to locate the row's pinned position — fine, pins hold ordered paths). Reconcile with the append-to-pin-at-tail rule (new rows land after the cursor — correct by construction).
- Does the client still need the shrink restarts? Likely only `orderToken`/repin reset remains mandatory.
- Wire shape: `cursor?: string` on `ListFoldersCommand`, `cursor?: string` in the response; keep `offset` working for compatibility testing and the driver.
- Interaction with search-context changes (a new query already restarts at 0 — unchanged).

### Verification

`tools/manual-test/folder-paging-smoke/` has the deep-scroll continuity, shrink, and net-zero scenarios. Extend it with a deterministic net-zero case (match leaves + match enters between windows) that is skipped today; it must go green.

## 2. `folders_status` async push (D2-(b)) — only if measurement demands it

Recorded in DR-058 as the named follow-up. **Do not build without evidence:** the trigger is real-world window requests at ~3.5k rows taking seconds (cold server, slow disk). Current behavior (D1, shipped): windows serve identity facts immediately, then probe git status for just that window's ≤100 rows before responding — 840ms cold first window, warm repin 3ms, probes cached with TTL (`probedOnly` guards the refresh diff).

### The change

Serve windows without awaiting probes; push finished git facts to clients in a new additive wire event, e.g. `folders_status` carrying `{ rows: FolderInfo[]; epoch? }` for the probed paths. Client merges status facts into its cached rows without touching epoch/shrink/restart semantics (status is display-only — it never participates in ordering, see DR-058).

### Why it was deferred (don't relitigate, just re-measure)

New wire event + client merge path; Android mirror sees an unknown event (acceptable — it's already behind the hard cut, but record it); `broadcastFoldersChanged`'s one-retry buildDelta pattern is the model for a retry-safe status emitter.

### Land mines (from the shipped fixes — same class will bite again)

- Git facts must never enter ordering or epoch semantics; only identity facts do.
- Any diff over repo facts must respect `probedOnly` (`server/src/repo-index.ts`) or first-time probes read as mass row changes — this caused a full-list delta storm once already.
- Bounded probe concurrency lives in `server/src/concurrency.ts` — keep using it.

## Ground rules for either session

- Wire changes are additive; the Android hard cut stands (Android must be updated separately — P1 in the product-manager backlog covers paging + deltas, and a new event belongs in that update's scope too).
- Tests: the suites pin a lot of this behavior; escalate/amend with justification rather than weakening assertions. The topic's test history shows authorized amendments happen via explicit ruling.
- Relevant surfaces: `server/src/folder-listing.ts` (pins, query, buildDelta), `server/src/repo-index.ts` (listLazy/enrichStatus/probedOnly), `shared/src/protocol.ts` (window contract), `client/src/lib/stores/folder-store.svelte.ts` (accumulating cache, frontier trigger, restarts), `client/src/lib/components/FolderList.svelte` (virtualizer, frontier-triggered fetch), glossary terms: pinned order, order token, repin, listing window, two-tier search, matched sessions, wire epoch, fetched frontier.
