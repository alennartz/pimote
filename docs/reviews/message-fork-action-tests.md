# Test Review: Message-level Fork Action

**Plan:** `docs/plans/message-fork-action.md`
**Brainstorm:** `docs/brainstorms/message-fork-action.md`
**Date:** 2026-04-12

## Summary

Server-side tests thoroughly cover the fork command protocol: validation, runtime invocation, session replacement lifecycle, cancellation, and the entryId pass-through in message mapping. The one gap was the brainstorm's most distinctive behavior — client-side draft conflict resolution (Replace/Append/Prepend/Ignore) — which had no tests because no client-side interface was materialized. This was resolved by extracting the draft policy logic to a testable pure function and adding tests. All brainstorm intent now has corresponding test coverage.

## Findings

### 1. Missing client-side draft conflict test coverage

- **Category:** missing coverage
- **Severity:** warning
- **Location:** (no file existed — gap in test-write phase)
- **Status:** resolved

The brainstorm's key decision on draft collision handling (Replace/Append/Prepend/Ignore when the editor has content during fork) had no test coverage. The architecture placed this logic in `MessageList.svelte` as local component state, and the test-writing phase only materialized server-side interfaces. However, client-side testing is an established pattern in this project (18 test files under `client/src/lib/`), so the gap was fixable.

**Resolution (approved by user):** Extracted draft policy logic to `client/src/lib/draft-policy.ts` as two pure functions (`needsDraftPrompt`, `applyDraftChoice`) and added `client/src/lib/draft-policy.test.ts` with 10 test cases covering conflict detection and all four choice outcomes. Updated the plan's Architecture (added Client draft policy interface section) and Tests section (added new interface and test files, added behavior list). The architecture now explicitly defines the draft policy contract alongside the server contract.
