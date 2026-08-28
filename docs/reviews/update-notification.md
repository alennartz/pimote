# Review: Update Notification

**Plan:** `docs/plans/update-notification.md`  
**Diff range:** `64acee2e261ccc555fc6bfb1d0c93d44765856c2..9de0950810ecdef0bf8c3aabb948d44fb02bdbcc`  
**Date:** 2026-08-28

## Summary

The implementation follows the plan closely: all planned modules and surfaces are present, the feature tests remained immutable after test writing, and the repository verification commands pass. Two reliability/coverage concerns remain: a stalled npm request can hold the checker's single-flight promise indefinitely, and the disabled startup path plus absent-checker connection path lack regression tests. The version-lookup import cycle is currently harmless but creates an avoidable future initialization risk.

## Findings

### 1. Disabled and absent-checker paths are not regression-tested

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/index.test.ts:132-148`; `server/src/server-update-check.test.ts:31-62`
- **Status:** resolved

The plan's known test gap remains: no immutable test drives `main()` with `updateCheck: false` to prove the checker and npm adapter are neither constructed nor warmed, and no wiring test proves that an accepted connection with no checker emits no update event. The implementation has structural guards, but these untested paths could regress and re-enable registry traffic or accidental event behavior without the feature suite detecting it.

Added regression coverage in `server/src/index.test.ts` for the disabled startup path and in `server/src/server-update-check.test.ts` for an accepted connection without a checker. The tests verify no checker construction, warm-up, adapter call, or update event.

### 2. Registry fetch has no feature-owned deadline

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/update-check.ts:72-78`; `server/src/server.ts:259-264`
- **Status:** resolved

`fetchLatestVersionFromNpm()` performs a global `fetch` without an abort signal or total deadline. If a registry or proxy hangs, or keeps a response trickling, the checker's singleton `inFlight` promise can remain pending indefinitely. Every later accepted connection then attaches another continuation to the same unresolved promise, while no refresh can begin and clients never receive update status; the server remains usable, but notification availability and per-connection handler/resource usage degrade until the process restarts.

Added a 10-second `AbortSignal.timeout` to the registry adapter and a regression test proving a rejected request resolves as no update and permits a fresh refresh after the TTL. This is a correctness fix: a hung request could permanently wedge update checking for the process lifetime, not merely delay one notification.

### 3. Version lookup creates an avoidable module cycle

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/index.ts:14`; `server/src/cli.ts:9,26-30`
- **Status:** resolved

Importing `getVersion()` from `cli.ts` makes `index.ts` and `cli.ts` cyclic. Current top-level initialization does not read the cyclic binding, so this works today, but a later top-level change in either module could access an uninitialized ESM binding and fail during startup. The cycle also weakens the intended clean seam around version metadata.

Extracted `getVersion()` to `server/src/version.ts`; `index.ts` imports that cycle-free module directly, while `cli.ts` re-exports it for existing importers.

## No Issues

Plan adherence: no significant implementation deviations were found beyond the explicitly documented coverage gap. No additional correctness, security, race, or resource-management issues were identified.
