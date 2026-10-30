# Test Review: Global settings

**Plan:** `docs/plans/global-settings.md`
**Brainstorm:** `docs/brainstorms/global-settings.md`
**Date:** 2026-10-30

## Summary

The tests cover the approved file-editor and extension-host contracts after the fixes below. Added tests close lifecycle, renderer, orchestration, error, and label-collision gaps. Production consumer wiring and documentation remain explicit manual acceptance items, with approval from the owner through the orchestrator.

## Findings

### 1. Asynchronous shutdown and fresh modules lacked coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/pimote-extensions/host.test.ts:111-217`
- **Status:** resolved

The original lifecycle test used synchronous shutdown and unchanged module contents. It could not prove awaited shutdown or module-cache reset. Added a controlled shutdown gate, changed module contents, concurrent reload requests, and observable registry assertions. The test rejects overlapping shutdown and factory execution without using elapsed time. The owner approved this resolution.

### 2. Approved dialog states lacked renderer tests

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `client/src/lib/components/global-settings-presentation.test.ts:12-60`
- **Status:** resolved

Pure presentation tests did not prove that the dialog rendered the approved mock. Added `GlobalSettingsDialog.test.ts` for accessible gear opening, modal overlay, conversation omission, tabs, dirty markers, missing-file hints, Markdown-only Tag controls, responsive actions, and discard confirmation. The renderer interface now accepts viewport, surface, and capability snippets. No visible Settings title is required, matching the mock. The owner approved these additions.

### 3. Reload and folder replacement lacked orchestration contracts

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/ws-handler.test.ts:2322-2348`, `server/src/repo-index.test.ts:74-102`
- **Status:** resolved

The architecture required global Pimote reload before current-session Pi reload and atomic replacement of extension sources with folder deltas. Added an injected `reloadPimoteExtensions` callback to the WebSocket interface and an interface-only `RepoIndex.replaceUserSources` operation. Tests use a controlled reload gate and observable listings/deltas. Core registrations survive replacement, including replacement with an empty extension registry. The owner approved these minimal interfaces and rejected a broader lifecycle facade.

### 4. Reload assertions selected an unspecified flight policy

- **Category:** over-specified
- **Severity:** warning
- **Location:** `server/src/pimote-extensions/host.test.ts:156-181`
- **Status:** resolved

The original concurrent test demanded two distinct fresh runtimes and exact factory counts. The plan described shared serialized flights, while the brainstorm required serialization only. The owner approved non-overlap and final-registry assertions without choosing coalescing or queueing. Updated the plan accordingly. Removed a registry object-identity assertion because snapshot identity is not part of the interface.

### 5. Error and collision paths were incomplete

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/stores/global-settings.svelte.test.ts:184-222`, `server/src/global-settings.test.ts:57-61`
- **Status:** resolved

Added manifest error responses, rejected manifest/file transports, preserved drafts after rejected saves, cleared pending flags, and safe failed-load state. Added basename collisions that require more than one parent segment. These tests exercise supported operations and declared state. The owner approved the coverage additions.

### 6. Live consumer wiring is not covered by the materialized interfaces

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/config-runtime.test.ts:39-91`, `server/src/server.ts:309-318`
- **Status:** dismissed

Runtime tests cover the safe-field matrix, startup-only preservation, native validation, ordinary writes, and capability payloads. Added captured consumer adapters to verify future session/voice/buffer policy and the next idle check. These adapters do not prove production session, voice, buffer, idle, or capability-broadcast wiring. The owner approved implementation and manual acceptance for those integration checks rather than widening interfaces for this phase. The plan records that scope.

### 7. Documentation and public SDK removal need acceptance evidence

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `docs/plans/global-settings.md:189-192`
- **Status:** dismissed

The brainstorm requires SDK guidance, examples, host-scope documentation, and removal of the public FolderCreator seam. The interface exports were inspected and contain the Pimote factory/context without FolderCreator. No existing SDK compile-time test pattern was found. The owner approved documentation and public-vocabulary checks as manual acceptance. No brittle runtime documentation tests were added.

## Validation

- Read the brainstorm, architecture, listed interaction mock, tests, and relevant materialized interfaces.
- Manifest, configuration, store, host, and renderer tests cross their supported interfaces.
- Temporary filesystem fixtures isolate path tests. Controlled promise gates isolate lifecycle sequencing. No network or random ordering controls these assertions.
- Server test run: 207 passed, 29 failed across the selected five files.
- Client test run: one passed, 32 failed across the selected three files.
- Failures are expected at this phase because the new interfaces remain unimplemented. The global-reload test also fails until the callback is wired.
- `git diff --check` passed.
