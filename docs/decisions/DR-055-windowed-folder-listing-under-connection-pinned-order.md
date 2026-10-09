# DR-055: Windowed folder listing under a connection-pinned order

## Status

Accepted

## Context

One folder source contributes ~3.5k folders. `list_folders` shipped the full merged list, the client fired `list_sessions` per folder to compute recency, and every row rendered. Transfer, fan-out, and rendering all lagged. Server-driven windowed listing (DR-053's folder model underneath) needed a pagination scheme whose pages stay stable while mutable sort keys — session recency — change underneath them.

## Decision

**Offset/limit windows over a per-connection pinned order.** The server pins the sort order at WebSocket open (`favorite desc → lastActivity desc → name asc → path asc`; path is the deterministic tiebreak stable pagination needs) and serves windows `[offset, offset+limit)` of that order (default 100, clamped to [1, 200]). The pin holds order only: row data re-resolves from the registry at query time, so curation edits never serve stale rows. Explicit refresh (`repin`) replaces the pin; the client adopts the returned `orderToken` for continuation windows.

**Server-side two-tier search over the full set.** A query filters the whole pinned order — never-loaded rows can match — in two OR'd tiers: folder fields (display name, name, path, tags) and session `name`/`firstMessage` (returning `matchedSessionIds`). Filter then slice; `total` is the post-filter count.

**Client accumulates rows by canonical path and fetches on infinite scroll.** Windows merge into a path-keyed cache; the view virtualizes and re-sorts the fetched subset live. We rejected cursor/keyset pagination as the primary scheme because offsets give page jumps and totals, and the client refetches windows on invalidation anyway (PM call). We rejected client-local search over loaded rows because it would lie: at 3.5k folders most rows are never fetched. We rejected forced re-pins on every mutation because they recreate the instability the pin exists to avoid — connection-scoped pins plus delta merge are good enough. We rejected top-N style requests (no totals, no window continuity) and page controls (the interaction is infinite scroll).

## Consequences

- The filtered order can shrink mid-scan (session-metadata-driven match loss) and shift offsets. Shrink-restart triggers cover the observable cases: a session edit that strips the sole session-tier match of a fetched row restarts the scan, and a continuation response reporting a smaller `total` than the previous response of the same scan restarts as a correctness backstop.
- A residual case stays open: one match leaving and another entering between two windows net to an unchanged `total`, which masks the shift. The named **keyset/offset-correction follow-up** kills this bug class permanently; it is recorded, not implemented.
- Complete-list consumers — manager `pimote_list_folders` and hub-member management — deliberately stay unwindowed over their own registry seams. Windows apply only to the `list_folders` protocol command.
- The wire change breaks old clients. The compatibility cut is DR-056's subject.
