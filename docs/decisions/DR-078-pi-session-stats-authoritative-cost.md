# DR-078: Pi session stats are authoritative for lifetime cost

## Status

Accepted

## Context

Pimote needs a stable whole-session dollar total alongside per-message usage breakdowns. The earlier approach summed assistant-message costs from pi's session branch. That sum was idempotent, but it did not match pi's accounting surface: pi's session statistics include tool results, compactions, branch summaries, usage entries, compacted history, and alternate branches. A Pimote-owned scalar sum could therefore omit work that pi includes in the session total.

Supersedes DR-028 (Server-side idempotent cost recompute over the session branch), deleted at commit `f27cdd03d6814a33c83d0dd1dd70b2c08a7867f0`.

## Decision

Use `AgentSession.getSessionStats().cost` as the authoritative `lifetimeCostUsd` value. Read the statistic whenever Pimote builds session metadata, and do not recompute or replace pi's scalar total.

Build the tooltip's category breakdown separately from persisted `SessionEntry` values. Aggregate only the input, output, cache-read, and cache-write dollar fields from pi's usage-bearing assistant, tool-result, compaction, branch-summary, and usage entries. Copy pi's token totals from `SessionStats.tokens`; the category reducer does not calculate a scalar total or add subset token fields.

Rejected alternatives:

- **Continue summing assistant messages in Pimote** — rejected because it omits usage that pi includes and can disagree with pi after compaction or across alternate branches.
- **Recompute a scalar total from category fields** — rejected because pi's scalar total is the source of truth, while the category rollup exists only to explain it and can differ because of entry coverage or rounding.
- **Accumulate totals incrementally** — rejected because replay, reconnect, resync, and restart can apply the same entries more than once.

## Consequences

Pi owns lifetime-cost semantics, so the total remains consistent with pi's persisted accounting through compaction, reconnect, restart, and session lineage. Pimote still exposes useful category detail without claiming that its rollup replaces pi's total.

The category sum can differ from the authoritative total. The client treats a positive difference greater than one cent as `Unknown`, ignores differences within one cent as rounding, and flags larger category overages as inconsistent without showing a negative remainder. The displayed number remains pi's configured-price estimate, not a verified provider invoice.

The category projection must track new pi usage-bearing entry types if pi expands its accounting surface. Until then, the scalar total remains correct even when the explanatory categories are incomplete.
