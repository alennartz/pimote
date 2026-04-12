# Review: Tree Navigation

**Plan:** `docs/plans/tree-navigation.md`
**Diff range:** `0d91138b4c111387ffa9ddb4b01c574fca08bbde..WORKTREE` (HEAD `04d4ea14b30062f006fbe2be308f40ae7567b2d5` + uncommitted changes)
**Date:** 2026-04-11

## Summary

The implementation covers most planned tree-navigation functionality across protocol, server handlers, store logic, and UI integration. However, there are meaningful gaps in adherence to the planned interaction model and a few correctness issues around navigation lifecycle/concurrency that can cause duplicate navigation requests, out-of-order lifecycle signaling, and unintended dialog closing behavior. These should be addressed before considering this phase complete.

## Findings

### 1. Label editing UX deviates from planned in-dialog popover flow

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `client/src/lib/components/TreeDialog.svelte:197-203`
- **Status:** resolved

The plan specifies long-press/right-click label editing via an in-dialog popover with text input. The implementation uses `window.prompt(...)` instead. This is a notable interaction deviation (blocking native prompt, inconsistent styling/accessibility, no inline context), so the implemented behavior does not match the planned UI contract.

### 2. Non-summary navigation can be submitted multiple times concurrently

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/TreeDialog.svelte:44-49,249-257`
- **Status:** resolved

`canNavigate` depends on `!loading`, but `navigateSelectedNode()` sets loading to `false` for “No summary” mode (`setLoading(summarize)`). That leaves the button enabled while the request is in flight, allowing repeated clicks/double-taps to issue multiple `navigate_tree` commands concurrently and produce race-prone reset/editorText ordering.

### 3. Tree navigation lifecycle flag is unsafe under overlapping navigate requests

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:909-923`, `server/src/session-manager.ts:415-417`
- **Status:** resolved

`treeNavigationInProgress` is managed as a single boolean per session with unconditional `true` on start and `false` in `finally`. If multiple navigations overlap, the first completion clears the flag and emits `tree_navigation_end` while another navigation may still be running. This can emit misleading lifecycle events and re-enable idle reaping prematurely.

### 4. Cancelled navigation can leave close-on-resync armed

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/TreeDialog.svelte:144-149,157-165,269-270`
- **Status:** resolved

Every `tree_navigation_end` sets `closeOnResync: true`, but cancelled navigations return early and intentionally skip immediate resync. If the map entry remains armed, a later unrelated `full_resync` for that session can unexpectedly close the tree dialog.

## No Issues

- Test immutability check (required by plan): no changes were made after `pre-implementation-commit` to the test files listed in the plan’s Tests section (`server/src/ws-handler.test.ts`, `server/src/session-manager.test.ts`, `client/src/lib/stores/tree-dialog.svelte.test.ts`).
