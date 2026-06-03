# Review: Cost Accumulation in the Pimote UI

**Plan:** `docs/plans/cost-accumulation.md`
**Diff range:** `b7212414cae362213f271cf8d3e07d5dcb4b39c3..HEAD`
**Date:** 2026-06-03

## Summary

The plan was implemented faithfully and completely. All five steps are reflected in
the diff: `sumAssistantCostUsd` and `formatSessionCost` fill their stubs exactly as
specified, `updateMeta` assigns the session-specific cost, and the StatusBar renders
it in both the desktop (Row 1) and mobile (Row 2) groups with the documented
guards/styling. Test files are unmodified since the pre-implementation commit
(immutability holds), and all targeted suites pass (server 12/12, client 80/80). No
correctness concerns found.

## Findings

### Plan adherence: no significant deviations found.

Every step traces to the diff and matches intent:

- **Step 1** — `sumAssistantCostUsd` (`server/src/session-cost.ts:30-38`) filters
  `type === 'message'` and `message.role === 'assistant'`, sums
  `message.usage?.cost?.total ?? 0`, returns `0` for empty branch. Matches the
  contract exactly.
- **Step 2** — `formatSessionCost` (`client/src/lib/session-summary.ts:48-52`) returns
  `null` for `<= 0`, `"<$0.01"` for sub-cent, `"$" + usd.toFixed(2)` otherwise. Pinned
  rounding mode as documented.
- **Step 3** — `updateMeta` (`client/src/lib/stores/session-registry.svelte.ts:565`)
  assigns `session.lifetimeCostUsd` session-specifically (not folder-propagated like
  `gitBranch`); doc comment updated.
- **Step 4** — `StatusBar.svelte` renders `costDisplay` in both rows with the exact
  guards/styling specified; Row 2 visibility guard extended with `|| costDisplay`.
- **Steps already-in-place** — protocol field, `ws-handler` wiring, and
  `PerSessionState` init were established in the test-write phase and remain correct.

**Test immutability:** the three test files
(`server/src/session-cost.test.ts`, `client/src/lib/session-summary.test.ts`,
`client/src/lib/stores/session-registry.test.ts`) have zero changes between
`b7212414`..HEAD. Confirmed clean.

### Code correctness: no issues found.

- The `getBranch() as unknown as CostBranchEntry[]` cast in `ws-handler.ts:929`
  mirrors the established `SdkSessionEntry` pattern at lines 905/1364/1404 — idiomatic
  for this codebase, not a new risk.
- Floating-point summation in `sumAssistantCostUsd` can yield values like
  `0.30000000000000004`, but the display path (`toFixed(2)`) absorbs this and the
  plan explicitly documents a straight sum. Not a defect.
- `formatSessionCost` correctly handles the `<= 0` sentinel (including the
  shouldn't-occur negative case) and the sub-cent boundary; no unhandled inputs.
- No error paths, resource leaks, race conditions, or security surface introduced —
  the change is a pure recompute plus a read-only display.

## No Issues

Both passes ran clean. Plan adherence: no significant deviations. Code correctness: no
findings.
