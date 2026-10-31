# Test Review: fork-from-transcript-message

**Plan:** `docs/plans/fork-from-transcript-message.md`
**Brainstorm:** `docs/brainstorms/fork-from-transcript-message.md`
**Date:** 2026-10-31

## Summary

The reviewed tests now cover projection, search, transport lifecycle, and the approved automated interaction boundaries. The remaining visual interactions require manual checks. The tests remain red against interface stubs, as required before implementation.

## Findings

### 1. Transcript interaction boundaries lacked coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `docs/plans/fork-from-transcript-message.md:82-92`
- **Status:** resolved

The mocks require shared message actions, restricted-source guards, sticky target selection, and find cycling. Added component prop interfaces, menu tests, find-bar tests, and a pure sticky-target interface with tests. The orchestrator approved these boundaries. Explorer cancellation, jump scrolling, mobile layout, and rendered scroll anchoring remain approved manual checks. Existing `draft-policy.test.ts` and `InputBar.editor-request.test.ts` protect composer behavior.

### 2. Projection assertions did not prove the stated behaviors

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `client/src/lib/branch-tree.test.ts:30-64` (original tests)
- **Status:** resolved

The old tests checked positive segment counts and visible endpoints rather than hidden-message exposure. Replaced them with anchor identity, hidden-count, independent expansion, internal-node exclusion, active/inactive marking, logical depth, and empty/missing-input tests. Focus now targets a hidden message. Already visible anchors require no expansion. The orchestrator approved these changes and assigned responsive depth compression to rendering.

### 3. Store search and focus tests checked flags rather than results

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `client/src/lib/stores/branch-tree-store.svelte.test.ts:67-91`
- **Status:** resolved

Added hidden-message fixtures. Anchor search excludes collapsed text. Full search returns and selects exact entries and expands their segments. Focused open exposes a hidden target. The orchestrator approved these observable store-state assertions.

### 4. Failure behavior was undefined and untested

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/stores/branch-tree-store.svelte.test.ts:93-109`
- **Status:** resolved

The orchestrator defined open/navigation failures: set `state.error` and keep the explorer open. Added unsuccessful-response and rejected-transport tests for both operations. Updated the plan and interface documentation. Promise rejection versus resolution remains implementation freedom.

### 5. Label search was present only in the approved mock

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `docs/mocks/fork-from-transcript-message/tree-explorer.html:369-375`
- **Status:** resolved

The orchestrator approved label matching in both branch search phases. Updated the store contract and added label-search assertions. Transcript conversation search remains text-only. Label hits identify their message entry without requiring conversation-block offsets.

### 6. Text-block separator assertion used literal backslashes

- **Category:** over-specified
- **Severity:** warning
- **Location:** `server/src/ws-handler.test.ts:2443`
- **Status:** resolved

Changed the expected separator from literal backslash-n characters to two newline characters. This matches the protocol's text-block contract.

## Validation

- Client review suite: 28 failed, 2 passed across six files. Failures come from unimplemented interfaces and absent interface-stub controls.
- Server tree-navigation suite: 3 failed, 10 passed, 151 skipped. The new conversation-text and direct-read contracts remain unimplemented.
- Tests use fixed fixtures and controlled transports. No network, clock, random, or filesystem-order dependence was introduced.
- Component tests use rendered controls. Store tests inspect public state and wire commands. Projection tests use exported interfaces.
- The plan records the approved automated/manual split and review-added interfaces.
