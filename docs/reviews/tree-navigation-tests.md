# Test Review: Tree Navigation

**Plan:** `docs/plans/tree-navigation.md`
**Brainstorm:** `docs/brainstorms/tree-navigation.md`
**Date:** 2026-04-12

## Summary

The test suite is now aligned with the architecture contracts and the brainstorm’s server-driven navigation behavior. During review, I found several missing-coverage gaps around cancellation lifecycle, label clearing, filter/search modes, and tree preview mapping boundaries; all were fixed inline by adding tests. The updated tests remain at component boundaries (ws-handler/session-manager/tree-dialog store) and avoid implementation-detail assertions.

## Findings

### 1. Missing `/tree` mapping boundary coverage for preview truncation/fallback

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/ws-handler.test.ts:1680-1740`
- **Status:** resolved

The brainstorm/architecture requires wire-safe preview text (truncated) and stable node rendering for heterogeneous entry types. Existing tests validated happy-path mapping but did not verify truncation limits or fallback preview behavior for non-text entries. Added a `/tree` mapping test that asserts 200-char truncation with ellipsis and fallback preview to entry type for custom entries.

### 2. Missing cancelled-navigation lifecycle contract coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/ws-handler.test.ts:1828-1914`
- **Status:** resolved

The brainstorm explicitly defines server-owned navigation lifecycle behavior, including start/end events and reconnect-safe in-progress semantics. Existing tests only covered successful navigation with resync. Added cancellation-path coverage to assert: start/end events still emit, `summarizing` is false by default when no summarize option is provided, full resync is skipped on cancellation, and `treeNavigationInProgress` is reset.

### 3. Missing clear-label contract coverage

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/ws-handler.test.ts:1934-1962`
- **Status:** resolved

`set_tree_label` supports clearing labels (empty/undefined) per protocol comments and architecture intent. Existing tests only covered setting a label. Added coverage that empty-string labels are normalized to a clear operation (`appendLabelChange(entryId, undefined)`) while still returning success.

### 4. Missing client filter/search mode coverage

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/stores/tree-dialog.svelte.test.ts:85-139`
- **Status:** resolved

The brainstorm requires filter modes (default/user-only/all/labeled-only) and text search parity with TUI behavior. Existing store tests only validated default filtering and fold reset. Added tests for user-only/all/labeled-only behavior, preview-text search filtering, and local label clearing updates.

## No Issues

- No tests were found to be non-deterministic.
- No tests were found to depend on private implementation internals; assertions stay on public component/store/handler contracts.
- No unplanned-scope tests were found after the above fixes.
