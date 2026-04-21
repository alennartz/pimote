# Test Review: Voice Mode

**Plan:** `docs/plans/voice-mode.md`
**Brainstorm:** `docs/brainstorms/voice-mode.md`
**Date:** 2026-04-20

## Summary

Tests cover the brainstorm intent at the right abstraction level — walk-back surgery, voice-extension runtime transitions, server-side orchestrator lifecycle and bind/end paths, UI-bridge voice-mode gating, and the client-side call state machine all have behavioral tests against the materialized interfaces. Five issues were found and resolved inline: a walk-back contract violation for truncated speak blocks, a missing coverage area (speak tool-call interception + turn_end at the runtime level), a dead `'deactivating'` state in the union, a misleading comment on the UI-bridge gating tests, and a minor plan/protocol mismatch that was left as-is. Post-fix: 39 tests in `@pimote/voice`, all workspace tests pass, `npm run check` clean.

## Findings

### 1. Walk-back contract violation — truncated speak did not drop paired tool_result

- **Category:** over-specified implementation relative to contract (really: under-implemented against contract)
- **Severity:** warning
- **Location:** `packages/voice/src/walk-back.ts:138-150`, `packages/voice/src/walk-back.test.ts` (paired tool_result dropping block)
- **Status:** resolved

Plan contract step 3 says "For any speak tool_use that is **dropped or truncated**, the paired tool_result block (if present) is also dropped." The implementation only added to `droppedToolUseIds` on full-drop, not on truncation, and no test covered the truncated case. Fixed by recording `toolUseId(block)` in the truncation branch and added `drops paired tool_result blocks for TRUNCATED speak tool_uses` test. User approved fix (option a: match plan).

### 2. Missing runtime coverage — speak interception and turn_end

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `packages/voice/src/extension-runtime.ts`, `packages/voice/src/extension-runtime.test.ts`
- **Status:** resolved

Plan "Voice extension" section says the `tool_call` hook for `speak` intercepts the call, streams `{type:"token", text}` to speechmux, returns a trivial result, and emits `{type:"end"}` on assistant turn end. The pure-reducer runtime had no model for either behavior, so the impl phase had no behavioral target. Added `reduceSpeakToolCall` and `reduceTurnEnd` producing new `stream_speechmux_token`, `return_speak_tool_result`, and `emit_speechmux_end` actions (no-ops outside `active`), with matching tests covering active-state emission and non-active no-op. User approved (option a: extend runtime + tests).

### 3. Dead `'deactivating'` state in the voice-extension state union

- **Category:** wrong abstraction (spurious state)
- **Severity:** nit
- **Location:** `packages/voice/src/state-machine.ts:7`
- **Status:** resolved

`VoiceExtensionState` declared `'deactivating'` but no reducer ever entered it — `reduceDeactivate` transitioned straight to `'dormant'`. Since deactivation is synchronous (close WS, clear watermark; no async failure surface), the transient state was dead code. Removed `'deactivating'` from the union and documented the synchronous-teardown rationale above the type. User approved.

### 4. UI-bridge voice-mode test comment overstates the contract

- **Category:** over-specified documentation
- **Severity:** nit
- **Location:** `server/src/extension-ui-bridge.test.ts` — `voice-mode gating` describe-block comment
- **Status:** resolved

The comment claimed "fire-and-forget methods become no-ops (no events emitted)" during voice mode, but neither the plan, the code, nor any test required that. Plan's "Behaviors Covered" scopes gating to dialog methods only. Updated the comment to match reality (dialog methods only; fire-and-forget unaffected). User approved.

### 5. Plan `CallBindResponse` interface omits `sessionId`

- **Category:** plan/impl drift
- **Severity:** nit
- **Location:** `docs/plans/voice-mode.md` Interfaces → "Wire protocol extensions" block
- **Status:** dismissed

Plan's pseudocode for `CallBindResponse` lacks the `sessionId` field that `shared/src/protocol.ts` actually carries and that `voice-orchestrator.test.ts` asserts on. Harmless — impl + tests are the source of truth now. User dismissed: leave as-is.

## No Issues

All remaining brainstorm intent is covered:

- Wire protocol additions (`call_bind` / `call_end` / `call_bind_response` / `call_ready` / `call_ended` / `call_status`, `VOICE_INTERRUPT_CUSTOM_TYPE`, `UI_BRIDGE_DISABLED_IN_VOICE_MODE`) materialized in `shared/src/protocol.ts` and exercised through the orchestrator, UI-bridge, and client-store tests.
- Walk-back surgery steps 1–4 + idempotency + scope-limit (only latest turn) covered.
- Voice-extension state transitions + duplicate/out-of-order activate guard covered.
- Speechmux frame routing (user / abort / rollback) and non-active ignore covered.
- Orchestrator lifecycle, bindCall failure reason codes, force-displacement, endCall idempotency covered.
- UI-bridge dialog gating + toggling across calls covered.
- Client phase state machine (happy path, concurrent-call rejection, server rejection, getUserMedia/signaling failures, `call_ready` / `call_ended` / `call_status ringing` / non-regression of `connected`, `endCall` idempotency + local-teardown-on-failure, `toggleMute`) covered.

No non-deterministic tests were introduced; timing is handled through microtasks in the client fakes, and the only timeout-based behavior (`dialogWithTimeout`) was already present pre-review.
