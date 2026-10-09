# DR-056: Delta folders_changed with wire epochs and a hard compatibility cut

## Status

Accepted

## Context

`folders_changed` rebroadcast the full enriched folder list to every client on any mutation. At 3.5k rows the broadcast is itself a scalability problem: every curation edit, hub change, or discovery refresh shipped O(all rows) to every socket. The brainstorm proposed keeping older clients (Android, SDK consumers) working against an unwindowed default.

## Decision

**`folders_changed` becomes a delta event with a monotonic epoch.** The event carries `changed` rows (fully populated), `removedPaths`, and the epoch bumped on every emission. Each mutation site — registry update/createHub/disbandHub, discovery refresh, `create_folder`, `file_put` AGENTS.md edits — reports the exact paths it touched, including dependent hubs whose inherited rows change. The listing service reconciles touched paths against current rows: a reported removal that still resolves becomes `changed` (including `missing: true` rows), and a reported change that no longer resolves becomes a removal. Clients discard any window response whose computation epoch is older than the newest delta; fresh events apply regardless of interleaving.

**The wire change is a hard cut.** No compatibility shim, no unwindowed default. We rejected keeping the full-list broadcast because it is the O(all rows) problem itself. We rejected a versioned compatibility mode because permanent translation at every boundary is too much machinery for one lagging client — the user approved the break. We rejected tombstone-only invalidation signals because a client that learns only "something changed" must refetch windows to rebuild rows; a delta heals the cache in one event.

## Consequences

- Accepted debt: the Android protocol mirror breaks until its own update. That update must cover `list_folders` paging — Android reads `folders` and ignores `more`/`total`, so it silently truncates at the 100-row default limit — and not only the `folders_changed` delta change. No compat shim will be built.
- No SDK `FolderInfo` twin is added: `FolderInfo` is wire-protocol only, and folder sources contribute source entries, never wire rows.
- Dropped deltas leave phantom rows in client caches. Explicit refresh (`repin` cache-replace) and reconnect cache-replace are the heal paths; a delta retry or periodic reconcile is the revisit point if phantom rows ever matter in practice.
