# Test Review: Interactive Provider Login (`/login`)

**Plan:** `docs/plans/provider-login.md`
**Brainstorm:** `docs/brainstorms/provider-login.md`
**Date:** 2026-06-04

## Summary

The tests cover the brainstorm intent well and sit at the right abstraction level —
both suites drive the component through constructor-injected seams (server: an
in-memory `AuthStorage`/`ModelRegistry`/transport; client: a fake `sendCommand` bus),
asserting on observable behavior rather than internals. Validation surfaced two
genuine coverage gaps on the server orchestrator, both tracing to settled brainstorm
intent: the paste-back callback (`onManualCodeInput`, decision 5) and the abort path
(claimed in the plan's Tests section but unexercised). Both were fixed inline by adding
tests. No interface or architecture changes were needed — the existing seams already
supported the new coverage.

## Findings

### 1. `onManualCodeInput` callback untested

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/login-orchestrator.test.ts:200-215`
- **Status:** resolved

`onManualCodeInput` is the paste-back callback — the entire mechanism behind brainstorm
**decision 5** (paste-back login for Claude/ChatGPT, the headline UX for two of the three
providers). The `LoginOAuthCallbacks` interface declares it and the plan's `runLogin`
spec states `onManualCodeInput() → requestInput(paste prompt)`, but no test exercised it.
`onPrompt` was tested, but it is a distinct callback — covering one does not cover the
other. Fixed by adding a test asserting that when the provider invokes
`cb.onManualCodeInput()`, the orchestrator routes through `transport.requestInput` and
returns the pasted value (mirrors the existing `onPrompt` test). User (parent) approved.

### 2. Abort / cancel path unexercised

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/login-orchestrator.test.ts:271-303`
- **Status:** resolved

The `fakeTransport` exposed an `abort()` helper that no test ever called. The describe
block was titled "failure / abort" and the plan's Tests section claims "happy/abort/
failure paths" with the spec "On throw/abort → emit done{success:false}". The only
signal-related test merely confirmed the `AbortSignal` reference was threaded through the
callbacks — not that firing it produces a terminal failure step. Fixed by adding two
tests: aborting the transport mid-flow yields a terminal `done{success:false}` step, and
busy state is cleared afterward so a retry can start. User (parent) approved.

### 3. `select` step routing not in the dedicated routing block

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `client/src/lib/stores/login.svelte.test.ts:142-176`
- **Status:** dismissed

The `handleStep routing` describe block has explicit tests for `auth`, `device_code`,
`prompt`, and `progress` steps but not `select`. However, `select` routing is exercised
implicitly by the `submitInput` test (line 170 sets a `select` step via `handleStep`,
then reads back its `requestId`), so the behavior is covered. Left as-is — adding a
redundant dedicated test would not increase real coverage.

## No Issues

Beyond the findings above, validation was clean: tests are at component boundaries
(public surface in, observable result out), import only materialized interfaces, and are
deterministic (gated promises, no timing/randomness/network/filesystem dependence).
Assertions use `toMatchObject`/`objectContaining` rather than over-specifying exact
shapes, leaving correct implementations free. All other brainstorm intent — provider
listing, single-flight/busy guard, model-registry refresh on success (and no refresh on
failure), callback translation, the client flow state machine, input submission, cancel/
close, and the post-success model re-pull (including the no-viewed-session skip) — has
corresponding coverage.
