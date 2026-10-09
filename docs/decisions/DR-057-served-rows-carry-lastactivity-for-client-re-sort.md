# DR-057: Served folder rows carry lastActivity for client-side live re-sort

## Status

Accepted

## Context

The dashboard re-sorts the fetched folder subset live (favorite → recency → name) as session activity lands. After windowed loading, that re-sort derived recency from loaded session lists only. Rows whose lazy session list was not yet loaded sank below their pinned position. Manual testing showed a row landing mid-list and jumping to the top only when its own session list loaded — the ordering fact existed on the server but never crossed the wire.

## Decision

Every served row — query windows and delta rows — carries `lastActivity`, the same ordering fact the pin sorts on. The client re-sort folds `lastActivity` plus live-session counts, mirroring `favorite → lastActivity → name` from row data alone. We rejected loading session lists to sort because it reintroduces the per-folder `list_sessions` fan-out this work killed. We rejected freezing server order without a live re-sort because it regresses the live-reorder feel the dashboard has today. We rejected deriving recency from the client's session map alone because it has the same defect: only loaded rows have facts.

## Consequences

- The sort key is duplicated as a row fact and must stay consistent with the pin's ordering computation.
- Live session activity still re-sorts locally without refetching windows or loading session lists.
- This decision surfaced in manual testing after the plan shipped. Its rationale lived only in the manual-test artifact, which cleanup deletes — the DR preserves it.
