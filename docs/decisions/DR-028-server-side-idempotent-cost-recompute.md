# DR-028: Server-side idempotent cost recompute over the session branch

## Status

Accepted

## Context

Pimote needed to surface a per-session lifetime dollar cost in the UI so a user can
see what a coding session has spent. pi already computes a per-message dollar cost
(`AssistantMessage.usage.cost.total`, USD) from its per-model pricing table, so the
open question was not _how to price tokens_ but _where and how to accumulate the
running total_.

Two properties made the accumulation strategy non-obvious:

- pi **compacts** long sessions — old turns are replaced by a summary in the active
  context, but the original turns remain in the on-disk session branch.
- The metadata that carries the figure is refreshed on reconnect, session switch,
  and server restart, all of which replay or rehydrate state.

## Decision

Compute `lifetimeCostUsd` **server-side as a pure, idempotent sum** of
`usage.cost.total` over all assistant message entries in pi's session branch
(`session.sessionManager.getBranch()`), recomputed from scratch on each
`get_session_meta` fetch. The summation lives in a standalone pure helper
(`server/src/session-cost.ts` — `sumAssistantCostUsd`) and rides the existing
`SessionMeta` carrier alongside `contextUsage`; no new command or event type was
introduced.

Two alternatives were rejected:

- **Client-side sum of held messages** — rejected because a client only holds the
  messages currently in context. After a compaction, that set shrinks, so the
  displayed total would _drop_ — wrong precisely on the long, expensive sessions
  where the number matters most.
- **Incremental server-side accumulator** — rejected because a counter that adds
  each turn's cost as it arrives double-counts on event replay and reconnect
  resync.

The pure recompute avoids both: it is idempotent (no double-counting on replay),
monotonic across compaction (pre-compaction assistant entries remain on the branch),
and survives reconnect and server restart for free — on reopen the `SessionManager`
rehydrates the full branch from the on-disk JSONL session file, so the recompute
yields the same total.

## Consequences

- Correct and stable through compaction, reconnect, and restart with no extra
  bookkeeping; the cost figure is the twin of `contextUsage` and needs no new
  refresh triggers.
- The recompute runs on every meta fetch, but the entries are already in RAM and the
  branch is append-only, so the cost is negligible.
- **Fork lineage total (accepted):** a forked session's branch includes inherited
  parent entries, so the figure reads as "total cost of this conversation lineage,"
  including spend already paid in the parent. Revisit only if it proves confusing.
- **Unpriced models (accepted):** a model with no configured pricing reports
  `cost.total === 0`, so the figure shows `$0` even for real token spend. The number
  reflects what pi knows; not worth special-casing.
