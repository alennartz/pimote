# Manual Testing — server-folder-list-paging

Server-side folder listing: pinned order, windowed infinite scroll, two-tier
search, delta `folders_changed`, virtualized `FolderList`. Plan:
`docs/plans/server-folder-list-paging.md`. Brainstorm:
`docs/brainstorms/server-folder-list-paging.md`. Reviews:
`docs/reviews/server-folder-list-paging.md`,
`docs/reviews/server-folder-list-paging-tests.md`.

## Smoke Suite

Scoped subset of `tools/manual-test/PLAN.md` (focus hints fence this run to the
folder/dashboard surface; Android and voice are deliberate skips):

- **Journey 1 (dashboard half)** — `tools/manual-test/project-management-smoke/`:
  dashboard render, folder discovery shape, new session, resume, back
  navigation, active-session dot.
- **Journey 12** — `tools/manual-test/project-management-smoke/` (folders,
  hubs, curation, archive, search, manager chat) and
  `tools/manual-test/manager-tools-smoke/` (deterministic manager toolset
  backstop: complete-list `pimote_list_folders`, cached `pimote_folder_tree`).

Deliberately skipped (per focus hints): journeys 2–11 and 13 (outside the
folder/dashboard surface), Android client, voice surfaces.

## Topic-Specific Tests

Driver: new `tools/manual-test/folder-paging-smoke/` (real sandboxed pimote +
`agent-browser` + WS probe clients). Fixture: one scan root with ~250
fabricated code folders so the browser walks ≥3 continuation windows at the
default window size, plus fabricated pi sessions for recency ordering and
session-tier search.

Wire/probe tier:

1. **Window continuity over the full set** — accumulate the complete listing
   through tiny windows (limit 3) under one adopted token; no duplicate paths,
   no skipped paths versus a fresh repin listing; `total` constant; `more`
   flips false exactly at the end.
2. **Pin contract** — omitted token reuses the connection pin; a cross-owner
   token is rejected transparently (replacement token, same rows);
   `limit: 999` clamps to 200; a fresh `repin` returns a new token and a
   favorite-first order.
3. **Curation visible at query time without pin reordering** — an
   `update_folder` edit mid-scan is served in later windows of the same pin.
4. **Two-tier search, server-authoritative** — folder tier (name, path, tags,
   persona display name) matches rows never fetched by any window; session
   tier (session name / firstMessage) returns `matchedSessionIds` with exactly
   the matched ids; folder-tier matches omit `matchedSessionIds`; OR semantics;
   `total` is the post-filter count over the whole set; `includeArchived`
   changes rows and total together.
5. **`file_put` delta targeting** — an edited `AGENTS.md` emits a
   `folders_changed` delta for its containing folder row; a global-instructions
   edit emits no delta and no epoch bump.
6. **Discovery-added folder via delta** — a new repo mkdir'd on disk surfaces
   through a `folders_changed` delta (TTL background refresh) and is findable.

Browser tier (virtualized `FolderList`, real PWA):

7. **Deep-scroll continuity** — scroll through all ~250 rows; every listing
   row renders at some point (no silent skips, no duplicate rows); DOM row
   count stays bounded while scrolling.
8. **Curation edits mid-scroll** — favorite + archive + tag edits (probe-side)
   land while the view is deep in the list; continued scrolling still covers
   the full listing. Variant under an active query (the `shrank`/restart path).
9. **Query-match shrink mid-scan** — under an active session-tier query, a
   probe rename/delete of the sole matched session shifts the filtered order;
   continued scroll keeps full match coverage (review finding-4 bug class).
10. **Two-tier search in the UI** — folder-tier and session-tier matches;
    expanded session lists narrow to `matchedSessionIds` for session-tier-only
    matches and stay unrestricted for folder-tier matches; deep unfetched rows
    are found (server-authoritative); clearing search restores the accumulated
    view without a reload; typing bursts coalesce (debounced, ≤2 query
    requests per burst).
11. **Explicit refresh cache-replace** — the New-session dialog's refresh
    (`repin: true`) issues exactly one window request and replaces the cache:
    rows deleted while deltas were lost heal, no phantom rows, no duplicates.
12. **Reconnect cache-replace** — sever the browser socket, mutate rows
    server-side (deltas lost to the browser), let it reconnect: the deleted
    rows do not survive; no phantom rows.
13. **`folders_changed` deltas in the browser** — curation edits update rows
    live; `create_folder` rows appear via delta and are findable by search
    without a reload.
14. **Archive toggle × session lists** — toggling Show archived reloads only
    loaded/rendered session lists (no fan-out over the cached rows); archived
    rows appear/disappear per `includeArchived`.
15. **Lazy session loading** — after the initial settle, `list_sessions`
    requests cover only rendered rows (bounded count vs ~100 cached rows).

Adjacent (plan Step 7 behaviour, folded into tests 5 and 13): `file_put`
mapping and `create_folder` deltas are the folder-listing triggers that a
config-edit or creation flow leaves behind.

## Tools

- Reused: `tools/manual-test/project-management-smoke/` (smoke suite),
  `tools/manual-test/manager-tools-smoke/` (smoke suite),
  `tools/manual-test/lib/session-dir.mjs` (session fixture encoding),
  `agent-browser` skill (mandatory PWA driver).
- New: `tools/manual-test/folder-paging-smoke/` — paging/search/delta probe +
  browser driver over a ~250-row fixture (parameterized row count via
  `FP_FOLDERS`, screenshots via `FP_SHOTS`, sandbox retention via `FP_KEEP`).
- Improved: shared harness helpers extracted to `tools/manual-test/lib/`
  (sandbox boot, WS probe, browser helpers, reporter) and adopted by
  `project-management-smoke` and the new tool — see `tools/manual-test/README.md`.

## Harness Limitations

- **Scale:** ~250 fabricated rows, not the ~3.5k of the motivating source.
  Pagination arithmetic (pins, offsets, shrink restarts) is exercised across ≥3
  windows at every window size and is scale-independent; real-load latency and
  3.5k-row render jank are not exercised.
- **Fabricated session JSONLs** stand in for live pi sessions. The summary
  cache and search-text path are real file reads; live agent activity folding
  is approximated with probe-opened sessions, not real LLM runs.
- **Concurrency:** one headless browser plus WS probes stand in for multiple
  users. Race behaviour (debounce vs delta interleavings, epoch guards) is
  triggered deterministically where possible, not under real timing
  distribution.
- **Debounce** is measured by request counts on synthetic input bursts; real
  typing cadence varies.
- **Lost-delta scenarios** are induced by severing the browser socket.
  Mid-broadcast `buildDelta` failures are not induced.
- **Manager LLM phases** (smoke suite) are environment-bounded without the
  local `jetson` provider.

No primary behaviour of this topic is structurally invisible: each focus-hint
behaviour has a deterministic trigger against the real server + real PWA.
The gaps above weaken timing and load classes only; recorded, not escalated.

## Results

(to be filled after execution)

## Plan Updates

(to be filled after execution)

## Open Issues

(to be filled after execution)
