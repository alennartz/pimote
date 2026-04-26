# Test Review: voice-call-fullscreen-ui

**Plan:** `docs/plans/voice-call-fullscreen-ui.md`
**Brainstorm:** `docs/brainstorms/voice-call-fullscreen-ui.md`
**Date:** 2026-04-26

## Summary

Tests cover the four pure-helper boundaries the architecture deliberately extracted from the calling-mode Svelte components: the `VoiceCallStore` extensions (`startedAt`, `abortAgent`), the `deriveAgentState` / `formatCallDuration` helpers, the `recognizeCallGesture` recogniser, and the `createCallAudioCues` factory. Brainstorm intent (three agent states, three gestures, mute/abort audio cues, abort-stays-connected, duration tracking) maps cleanly to test behaviours. One under-specified assertion on the abort wire frame was tightened during review and a related architecture-doc inaccuracy corrected; otherwise the suite is at the right abstraction level, deterministic, and not over-constrained.

## Findings

### 1. `abortAgent` test did not pin the command wire type, and the plan named the wrong protocol constant

- **Category:** over-specified (in plan) / under-specified (in test)
- **Severity:** warning
- **Location:** `client/src/lib/stores/voice-call.svelte.test.ts:271-281`, `docs/plans/voice-call-fullscreen-ui.md` (Architecture → VoiceCallStore extensions)
- **Status:** resolved

The plan said `abortAgent` "routes through `seams.sendCommand` with the existing protocol shape" and named `VOICE_INTERRUPT_CUSTOM_TYPE` as the wire mechanism. That constant is actually a _persisted-entry customType tag_ the voice extension stamps on scrollback entries when it observes a rollback/abort — not a client→server command type. The real wire frame is the existing `AbortCommand` (`type: 'abort'`, sessionId-bearing) in `shared/src/protocol.ts`, which is what the store stub uses.

The test only asserted `cmd.sessionId === 's-1'` and left `cmd.type` unpinned, so an implementation could send any command shape and still pass. With user approval (option A), the test was tightened to also assert `cmd.type === 'abort'`, and the plan's Architecture section was rewritten to reference `AbortCommand` directly with a clarifying note about what `VOICE_INTERRUPT_CUSTOM_TYPE` actually is.

## No Other Issues

Validation against the criteria:

- **Brainstorm intent coverage** — all key decisions are exercised:
  - Three agent states (`listening` / `thinking` / `speaking`) with correct priority — `call-state.test.ts` covers default, streaming, audio-out wins over streaming, threshold-exclusive boundary.
  - Three gestures (tap / swipe-up / swipe-down) — `call-gesture.test.ts` covers each, threshold edges (inclusive 80px), the ambiguous mid-zone gap, custom thresholds, and the "slow stationary press is not a tap" guard.
  - Mute on/off audio cues distinguishable by ear — `call-audio-cues.test.ts` asserts mute-on > mute-off frequency.
  - Abort cue distinct from mute — abort is a double-beep with `start[1] > start[0]`.
  - `startedAt` lifecycle for the call-duration display — set on first `connected`, idempotent on re-entry, cleared on both `call_ended` and `endCall`.
  - Abort stays connected (vs hang-up which ends the call) — `abortAgent` leaves phase at `connected`; `endCall` returns to `idle`.

- **Abstraction level** — tests exercise public-surface helpers and the store's seam-driven contract. No reaching into internals.

- **Interface-only testing** — every test imports from a file listed in the plan's Tests → Interface Files section.

- **Path coverage** — happy paths plus boundary conditions (threshold edges, pitch ordering, idempotent `startedAt`, exclusive vs inclusive comparisons) plus error paths (`sendCommand` rejection swallowed, idle no-ops, getUserMedia / signalling failures from prior coverage). Audio-cue durations are asserted finite without pinning exact ms — appropriately loose.

- **Determinism** — `now` is injected via the `now` seam; AudioContext is injected via factory; gesture timestamps are explicit. No reliance on real time, real WebRTC, or filesystem.

- **Reasonable expectations** — assertions stick to interface-level observables (frequencies higher/lower, count of oscillators, phase unchanged). No call-count or ordering constraints beyond the contract.

Deferred component-level concerns (Svelte rendering of `CallingMode` / `CallHeader` / `CallStateRow` / `CallGestureZone`, the `MessageList.readOnly` prop, the `CallButton` `dialog-row` variant, the `+page.svelte` conditional render) are intentionally outside the chosen test boundary — pure helpers were extracted precisely so component rendering stays untested at this layer. This is a coherent choice and not a gap.
