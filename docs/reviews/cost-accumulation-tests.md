# Test Review: Cost Accumulation in the Pimote UI

**Plan:** `docs/plans/cost-accumulation.md`
**Brainstorm:** `docs/brainstorms/cost-accumulation.md`
**Date:** 2026-06-03

## Summary

The tests cover the brainstorm's intent well and sit at the right abstraction
level. The two behaviors with genuine logic — server-side cost summation and the
adaptive display string — are each isolated into a pure, unit-tested helper
(`sumAssistantCostUsd`, `formatSessionCost`), and the client session-state plumbing
is exercised through the registry's public API. All four key brainstorm decisions
(per-session lifetime scope, accuracy through compaction, session-specific state,
adaptive format) map to concrete tests. The only surfaces left untested are thin
glue — the `get_session_meta` handler wiring and the StatusBar render — both
deliberately decomposed into the tested pure helpers and consistent with the
existing `contextUsage` precedent. All stubbed/unwired tests fail in the expected
pre-implementation way and nothing else.

## Findings

### 1. StatusBar render of the cost figure is not directly tested

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `client/src/lib/components/StatusBar.svelte` (no colocated test)
- **Status:** dismissed

Brainstorm Decision 2 (location: StatusBar, desktop Row 1 / mobile Row 2, shown only
when nonzero) has no component-render test. This is intentional scoping: the
architecture pushes the only branching logic into the pure `formatSessionCost` helper
(tested in `client/src/lib/session-summary.test.ts`), leaving the Svelte template as
thin glue that renders the helper's output when non-null. This matches how the
existing `contextUsage` indicator is treated — its display logic lives in
`getContextDisplay` (tested) and the StatusBar render itself has no test. Dismissed as
a defensible component-boundary decision, not a coverage gap that affects the
behavioral contract.

### 2. `get_session_meta` handler wiring is not unit-tested

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `server/src/ws-handler.ts:924-929`
- **Status:** dismissed

The handler that produces `SessionMeta.lifetimeCostUsd` (via
`sumAssistantCostUsd(session.sessionManager.getBranch())`) has no direct test. The
summation logic it delegates to is fully covered in `server/src/session-cost.test.ts`;
the handler line is thin glue over an in-memory branch traversal already used by
`get_messages`. The sibling `contextUsage` field in the same handler is likewise not
separately tested. Dismissed — testing the pure helper in isolation is exactly the
testability split the architecture's "New Modules" section calls for.

## No Issues

Beyond the two dismissed scoping notes above, validation was clean:

- **Brainstorm intent coverage.** All four key decisions are covered. Per-session
  lifetime sum, monotonicity across compaction, malformed/missing cost handling, and
  the adaptive `$X.XX` / `<$0.01` / hidden-at-zero format all have explicit tests.
- **Abstraction level.** Every test exercises a public surface — the two pure helpers
  and the `SessionRegistry` public API. No test reaches into internals.
- **Interface-only testing.** Tests import only the materialized interfaces
  (`sumAssistantCostUsd`/`CostBranchEntry`, `formatSessionCost`, `SessionRegistry`).
- **Path coverage.** Happy paths, boundaries (empty branch, single entry, exactly one
  cent, whole dollars), and error/malformed cases (missing `usage`/`cost`/`total`, no
  `message` field, non-message entries) are all present.
- **Determinism.** No timing, randomness, network, or filesystem dependence.
- **Reasonable expectations.** Float sums use `toBeCloseTo`, matching the plan's
  "exact-equality tolerance is the implementer's call." The one rounding assertion
  (`1.235 → "$1.24"`) is satisfiable by the documented `toFixed(2)` contract (verified
  on the project's Node runtime). The `updateMeta` cost test correctly fails
  pre-implementation (assignment is implementation work, per the plan).
