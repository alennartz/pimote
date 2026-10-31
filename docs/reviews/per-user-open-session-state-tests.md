# Test Review: per-user-open-session-state

**Plan:** `docs/plans/per-user-open-session-state.md`
**Brainstorm:** `docs/brainstorms/per-user-open-session-state.md`
**Date:** 2026-10-31

## Summary

The listed tests (`server/src/user-profiles.test.ts`, `client/src/lib/stores/persistence.test.ts`) cover the profile store and persistence seams thoroughly, at the right abstraction level, with real files in temp dirs and no non-determinism. They fail only on the intentional `not implemented` stubs. Three pieces of brainstorm intent — wire flows, client migration reconcile, and the settings User pane — have no test coverage now; the user accepted the first two as required implementation-phase deliverables (recorded in the plan) and dismissed the third as intentionally untested.

## Findings

### 1. Wire-level behavioral contract has no tests

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `docs/plans/per-user-open-session-state.md` (Tests section); no test file
- **Status:** resolved

The plan's Interfaces section defines a wire contract marked "what tests assert" (connect burst delivery, no-echo broadcast, user-level detach isolation, socket-death stickiness, archive broadcast, restart survival), but the Tests section deferred runtime wire flows to the ws-handler wiring. Traced to brainstorm decisions 3 (sync, no echo) and 5 (survive restarts). User approved the deferral with a recording: the wire-flow behaviors are now a required implementation-phase test deliverable, written into the plan's Tests section. This is an architecture-covers-it, tests-later deferral, not a gap.

### 2. Client migration/reconcile logic has no tests

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `docs/plans/per-user-open-session-state.md` (Tests section); no test file
- **Status:** resolved

Brainstorm decision 4 (adopt-once: fresh profile adopts the local set; a stale second browser's entries are dropped, never opened) is key intent with no test. The Tests section covers only `persistence.ts` getters/setters, not the `user_sessions_changed` reconcile flow in `connection.svelte.ts`, which does not exist yet. User approved the deferral with the same recording: the fresh-gated reconcile tests are a required implementation-phase deliverable, written into the plan's Tests section.

### 3. Settings User pane (interaction mock) has no test coverage

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `docs/mocks/per-user-open-session-state/index.html`; no test file
- **Status:** dismissed

The approved mock defines dirty state, Save enablement, profile chips, and consequence copy, with no corresponding tests. No component-test infrastructure exists in `client/src`. User decided the pane stays intentionally untested by unit tests: the mock is the visual contract and manual journeys (two browsers on one user, user switch via settings) cover it end to end. Dismissal recorded in the plan's Tests section.

## No Issues

Not applicable — findings above. For completeness: abstraction level, interface-only testing, path coverage, determinism, and expectation reasonableness were all checked and clean across both test files.
