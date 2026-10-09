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
`agent-browser` + WS probe clients). Fixture: one scan root holding ~250
fabricated code folders (the browser walks ≥3 continuation windows at the
default 100-row window), fabricated pi sessions for recency ordering and
session-tier search, one persona folder.

Wire/probe tier:

1. **Window continuity over the full set** — complete listing through 3-row
   windows under one adopted token; no duplicate paths, no skipped paths,
   `total` constant, `more` false exactly at the end (83 windows).
2. **Pin contract** — omitted token reuses the connection pin; cross-owner
   token rejected transparently (replacement token, same rows); `limit: 999`
   clamps to 200; `repin` returns a fresh token and a favorite-first order.
3. **Curation at query time without pin reordering** — an `update_folder` edit
   mid-scan is served in later windows of the same pin at the same position.
4. **Two-tier search, server-authoritative** — folder tier (name, tags,
   persona display name), session tier (name/firstMessage) with exact
   `matchedSessionIds`, folder-tier matches omit `matchedSessionIds`, full-set
   filtering (unfetched rows match), `includeArchived` × rows and totals.
5. **`file_put` → AGENTS.md delta targeting** — top-level edit deltas its
   folder row; nested edit deltas the deepest owning row; global instructions
   edit emits no delta and no epoch bump.
6. **Discovery-added folder via delta** — a repo mkdir'd on disk surfaces
   through a `folders_changed` delta (TTL background refresh).

Browser tier (virtualized `FolderList`, real PWA, socket instrumentation):

7. **Deep-scroll continuity** — scroll through all ~250 rows; every listed row
   renders (no silent skips, no duplicates, no phantom rows); DOM row count
   bounded (max 36 rendered).
8. **Curation edits mid-scroll** — favorite + tag + archive edits land while
   the view is deep in the list; continued scrolling keeps full coverage;
   variant under an active query (the shrank/restart path).
9. **Query-match shrink mid-scan** — under an active session-tier query
   ("scuba", 130 matches over 2 windows), deleting a matched session shifts
   the filtered order; continued scroll keeps full match coverage.
10. **Two-tier search in the UI** — deep unfetched rows found;
    `matchedSessionIds` narrows expanded session lists; folder-tier matches
    keep all sessions; persona display name searchable; typing bursts
    coalesce into ≤2 query fetches (debounce) with the final query winning.
11. **Explicit refresh (`repin`)** — the create-folder flow sends exactly one
    `repin: true` window request; cache coherent afterwards, no duplicates.
12. **Reconnect cache-replace** — sever the browser socket, disband a hub and
    favorite a row server-side (deltas lost to the browser), reconnect: the
    disbanded hub does not survive (no phantom row) and the missed change
    heals.
13. **`folders_changed` deltas in the browser** — created folder row appears
    via delta without a reload and is findable by search; the discovery-added
    row is findable by search.
14. **Archive toggle × session lists** — toggling Show archived reloads only
    loaded/rendered session lists (86 reloads vs 60 previously loaded; no
    fan-out over the ~100-row cached set); the archived row reveals with its
    `Archived` badge when shown and leaves the view when hidden.
15. **Lazy session loading** — after the initial settle, zero session-list
    trickle; one scroll step requests sessions for the newly rendered rows
    only (13 requests / 16 new rows).

Adjacent (plan Step 7 behaviour, folded into tests 5, 11, 13): `file_put`
mapping, the create-folder refresh, and `create_folder` deltas are the
folder-listing triggers those flows leave behind.

## Tools

- Reused: `tools/manual-test/project-management-smoke/` (smoke suite),
  `tools/manual-test/manager-tools-smoke/` (smoke suite),
  `tools/manual-test/lib/session-dir.mjs` (session fixture encoding),
  `agent-browser` skill (mandatory PWA driver).
- New: `tools/manual-test/folder-paging-smoke/` — paging/search/delta probe +
  browser driver over a ~250-row fixture (parameterized via `FP_FOLDERS`,
  `FP_SHOTS`, `FP_KEEP`); page-side WebSocket instrumentation counts request
  types (`list_folders`/`list_sessions`, `repin`, `includeArchived`) and
  forces reconnects.
- Improved: shared harness helpers extracted to `tools/manual-test/lib/`
  (`report.mjs`, `sandbox.mjs`, `ws-probe.mjs`, `browser.mjs`) and adopted by
  `project-management-smoke` and the new tool; `WsProbe.listFolders` gained a
  `limit` parameter and `windowPaths`/`windowCount` duplicate/stream checks;
  `seedSession` accepts fixed timestamps via `lib/session-dir.mjs`; the
  agent-browser driver retries page-navigation blips and exposes
  `markSent`/`sentSince`/`pageConsole` diagnostics. See
  `tools/manual-test/README.md`.

## Harness Limitations

- **Scale:** ~250 fabricated rows, not the ~3.5k of the motivating source.
  Pagination arithmetic (pins, offsets, shrink restarts) is exercised across ≥3
  windows at every window size and is scale-independent; real-load latency and
  3.5k-row render jank are not exercised. Cold first-window latency was
  measured at 250 rows (see Open Issues) and extrapolates badly to 3.5k.
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
- **Request instrumentation** wraps `WebSocket.prototype.send` after page
  load; requests sent before installation are invisible (counts are taken as
  deltas after `markSent`). The create-folder flow can open a session view
  seconds after the click (slow create round-trip on a large fixture), so the
  driver polls instead of assuming fixed timings.
- **Manager LLM phases** (smoke suite) are environment-bounded without the
  local `jetson` provider.

No primary behaviour of this topic is structurally invisible: each focus-hint
behaviour has a deterministic trigger against the real server + real PWA. The
gaps above weaken timing and load classes only; recorded, not escalated.

## Results

Runs: the smoke suite plus the topic driver (seven driver iterations while
three surfaced product defects were fixed inline and the driver's own
instrumentation was corrected; the tally below is the final run: 86 checks
pass, 1 open, 1 environment-bounded).

### Smoke Suite

- `tools/manual-test/manager-tools-smoke/` — **pass**. Manager toolset
  registration/execution over real folder-model + registry ports.
  Coherence: looks coherent (complete-list rows, sparse tree shape).
- `tools/manual-test/project-management-smoke/` — **pass** (re-run after the
  inline fixes). All structural, curation, hub, fallback-session, reconnect,
  and manager-chat checks green; 5 manager-LLM items environment-bounded
  (local model slow/unreachable — no jetson replies in the polling windows).
  Coherence: looks coherent (dashboard, icons, hub chips, archived badge,
  missing-member chip, mobile manager all match the plan's intent).

### Topic-Specific Tests

Wire tier (items 1–6): all **pass**. Three product defects surfaced and were
fixed inline:

- **fixed-inline** — cold listing fired an unbounded git-probe burst (≈1000
  concurrent `git` spawns at 250 rows; 9.3s cold window). Fix: bounded probe
  concurrency in `repo-index.ts` (extracted `mapWithConcurrency` to
  `server/src/concurrency.ts`, shared with `session-summaries.ts`). Cold
  window: 9.3s → 6.7s. Note for cleanup's DR consideration.
- **fixed-inline** — `kickRefresh`'s refresh diff reported first-time git
  status probes as row changes: one spurious `folders_changed` with every
  real repo, epoch bumps, in-flight windows discarded (the review-finding-3
  bug class through an uncovered path). Fix: the diff now restricts status
  facts to entries probed before the snapshot (`probedOnly`); regression test
  added (`does not report first-time git status probes as row changes`, red
  before the fix).
- **fixed-inline** — `file_put` AGENTS.md edits called `repoIndex.invalidate()`,
  clearing warm git probes so the delta's row re-resolution paid a full
  cold re-walk + re-probe (multi-second delta latency at 250 rows, minutes at
  3.5k). Fix: new `RepoIndex.invalidateListing()` keeps warm probes (own TTL
  still bounds staleness); the `file_put` path uses it. Regression test added
  (`invalidateListing re-walks discovery while keeping warm git probes`).
  The same full-`invalidate()` pattern remains at four other mutation sites —
  see Open Issues.

Browser tier: items 7–13 and 15 **pass**. Item 14 partially:

- **pass** — no-fan-out reload bound (86 reloads vs 60 previously loaded,
  never enumerating the ~100-row cached-but-unloaded set).
- **open** — `show-archived reveals the archived row with its badge` failed in
  four consecutive runs. See Open Issues for the diagnosed evidence.

Coherence verdicts (UI-bearing journeys):

- Dashboard + virtualized folder list — **looks coherent**: rows render with
  the four icon variants, persona name + subtitle, branch chips, tags, stars;
  bounded DOM while deep-scrolling.
- Two-tier search — **looks coherent**: screenshot `02-search.png` shows the
  session-tier match as one folder row with `FOLDERS 1` and exactly the
  matched session ("submarine repair log") in the expanded list — the
  narrowing reads exactly as designed.
- Archive toggle — **looks off**: the `Archived`-badge row does not render
  after Show archived until a search-clear refetch re-measures the list
  (Open Issues 1). The rest of the toggle (rows/totals via `includeArchived`,
  hide behaviour, session-list reload scope) is correct.
- Explicit refresh + reconnect — **looks coherent**: one repin request,
  created folder visible after closing the session, phantom hub healed on
  reconnect.

## Plan Updates

- **Modified — journey 12**: driver list gains
  `tools/manual-test/folder-paging-smoke/` (windowed-listing behaviours at
  scale: window continuity incl. mid-scroll curation edits, two-tier search
  with `matchedSessionIds` narrowing, delta delivery, refresh/reconnect
  cache-replace, archive toggle × session lists, rendered-row-only session
  loading).

## Open Issues

1. **Archived row unrenderable after Show archived (virtualizer measurement
   collapse).** Observation: after the archive toggle (offset-0
   `includeArchived` window + bulk session-list reloads), the archived row
   never renders; a full scroll of the list cannot reach it. Evidence from
   the driver's geometry probe: `scrollHeight: 9577` px for a 251-row list
   (~38 px/row vs ~82 px real row height) while `data-index` spans 0–249 —
   the virtualizer's total size collapses to about half the real content, so
   deep rows fall outside the scrollable range. Recovery: any search-clear
   refetch re-lands window data and re-measures (`retry-after-clear=true` in
   every failing run), so row data is present and the virtual slot is lost.
   Suspected cause: measurement-cache drift in `FolderList`'s TanStack wiring
   (`measureRow`'s destroy calls `instance.measureElement(null)`; rows
   measured while the toggle's 80+ session-list loads reshuffle heights).
   Not fixed inline: the plan made virtualization an explicit test exclusion
   ("no stable non-visual seam"), the fix needs a real measurement-lifecycle
   investigation, and the reproducer is the toggle's bulk-reload moment.
   Suggested direction: re-measure (`virtualizer.measure()`) after
   `setShowArchived` window adoption, and drop the `measureElement(null)`
   destroy call pending its purpose.
2. **Four remaining `repoIndex.invalidate()` mutation sites clear warm git
   probes.** `create_folder`, `create_hub`, `disband_hub` (ws-handler) and
   `FolderRegistry.disbandHub` invalidate discovery through the full reset,
   so the delta's row re-resolution re-probes every repo (the same stall the
   `file_put` fix removed: seconds at 250 rows, minutes at 3.5k). The
   `invalidateListing()` seam exists and is the right call for all four
   (they change discovery shape, not git facts). Not fixed inline because
   `ws-handler.test.ts` pins the `invalidate` method name in the
   create_hub/disband tests; switching needs those assertions re-expressed —
   a test-contract change the review phase should bless.
3. **Cold first-window latency at scale.** The first `list_folders` blocks on
   the discovery walk plus a full git-status pass (6.7s at 250 fabricated
   rows after the concurrency bound; previously 9.3s). The plan's nonblocking
   contract covers the session-metadata scan; repo-index's documented "cold
   cache blocks on the walk" is what this measures. At 3.5k rows first paint
   will take tens of seconds — the motivating dashboard would still feel slow
   on a cold server. Direction: lazy/on-demand git-status enrichment (serve
   rows without status, probe rendered/expanded rows), or treat first-probe
   status as non-blocking row patches via `folders_changed`.
