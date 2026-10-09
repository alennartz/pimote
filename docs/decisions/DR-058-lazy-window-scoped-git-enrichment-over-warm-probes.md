# DR-058: Lazy window-scoped git enrichment over warm probes

## Status

Accepted

## Context

The first `list_folders` window blocked on a whole-set git-status pass. Manual testing measured ~1000 concurrent `git` spawns and a 9.3 s cold window at 250 fabricated rows — extrapolating to minutes at the motivating 3.5k. Two follow-on defects rode on the same design: the refresh diff counted first-time status probes as mass row changes (spurious O(all rows) deltas and epoch bumps), and AGENTS.md edits called full `repoIndex.invalidate()`, clearing warm probes so delta re-resolution paid a cold re-walk plus re-probe. Git facts never participate in folder ordering.

## Decision

**Identity facts first; git status on demand per window and delta.** `RepoIndex.listLazy()`/`enrichStatus()` serve identity facts and probe only requested paths; `FolderRegistry.listLazy()`/`enrichRows()` patch served rows in place; `FolderListing` enriches window and delta rows only. `list()` keeps its probed-status semantics for the complete-list consumers. Discovery-shape-only mutations (create_folder, create_hub, disband_hub, AGENTS.md edits) call `invalidateListing()`, which re-walks discovery but keeps warm git probes — the probe TTL still bounds staleness. Full `invalidate()` remains for real fact changes (open-hook provisioning). Probe concurrency is bounded through the shared `mapWithConcurrency` helper (`server/src/concurrency.ts`), and refresh diffs restrict status facts to entries probed before the snapshot (`probedOnly`). We rejected probing the whole set before the first window (measured 9.3 s at 250 rows; the window does not sort on git facts). We rejected pushing async status patches after the response — deferred as the follow-up below, since awaiting the window's few probes proved adequate. We rejected caching scan rows in the listing service because the module boundary forbids it: the service caches derived metadata and orderings, never scan results.

## Consequences

- Deep-scroll windows may re-probe past the status TTL. Accepted trade-off for the cold-window win (first window 840 ms at 248 rows after the fix; warm repin 3 ms).
- Named follow-up **D2-(b)** (recorded, not implemented): if window-scoped enrichment proves too slow in practice — cold servers at ~3.5k rows — push async `folders_status` patch events after the response instead of awaiting the window's probes.
- Any new diff over repo facts must keep the `probedOnly` restriction, or first-time git status probes will again read as mass row changes.
