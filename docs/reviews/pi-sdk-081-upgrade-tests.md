# Test Review: Pi SDK 0.81 Upgrade

**Plan:** `docs/plans/pi-sdk-081-upgrade.md`
**Brainstorm:** none — the architecture and completed upgrade audit define intent.
**Date:** 2026-07-23

## Summary

The tests exercise the architecture’s new deterministic public contracts: retained provider-information notices and complete persisted lifetime-cost accounting. They operate through `LoginStore` public state/operations and the public cost-fold function; they use no external provider, filesystem, timer, or network state. The breaking Pi-runtime integration remains covered by the existing `LoginOrchestrator` suite, which must be migrated from the removed auth/registry APIs while preserving its established behavior tests.

## Findings

### 1. Flow-reset coverage for retained notices

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/stores/login.svelte.test.ts:225-234,343-353`
- **Status:** resolved

The first red test proved only that an `info` step survives a later prompt. It did not verify the architecture’s reset-per-flow invariant, so stale provider instructions could have leaked into the next login or a newly opened dialog. Added deterministic public-state tests for `begin()` and `close()` clearing notices.

### 2. Invalid persisted cost values

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/session-cost.test.ts:24-35`
- **Status:** resolved

The initial cost test covered normal assistant, compaction, and branch-summary values but not the architecture’s explicit zero-contribution rule for malformed or irrelevant values. Added a pure test covering missing, non-finite, negative, and user-message values.

### 3. Target-runtime adapter coverage

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/login-orchestrator.test.ts`
- **Status:** resolved

The existing suite already covers provider listing, single-flight, prompt/select transport, terminal outcomes, aborts, and refresh behavior. Its current fakes model the removed `AuthStorage`/`ModelRegistry` surface, so the implementation must replace those fakes with a target `ModelRuntime` seam and preserve the same behavioral cases, adding `info` interaction mapping. This is a migration of an existing component-boundary suite rather than a second, parallel test surface; the implementation plan names it as a required verification point.

## No Issues

No abstraction, determinism, or unplanned-scope issues remain. The red tests run successfully and fail only because their declared behavior is deliberately unimplemented.
