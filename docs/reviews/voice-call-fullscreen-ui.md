# Review: voice-call-fullscreen-ui

**Plan:** `docs/plans/voice-call-fullscreen-ui.md`
**Diff range:** `da7b78c486b375cd5bcbe83e39c7fac87334bf5d..HEAD`
**Date:** 2026-04-26

## Summary

The plan landed faithfully — all 12 steps are reflected in the diff, the architectural contracts (calling-mode subtree, prop additions, gesture/audio semantics, store extensions, banner removal) match the plan, and test/interface files are unchanged since the pre-implementation commit (`c5354ac`). The code-correctness pass surfaced no critical bugs but several worthwhile lifecycle/teardown hazards in the new `voice-call-seams.ts` analyser path and a couple of nits around the gesture zone and timers.

## Findings

### 1. Stale `track.ended` listener tears down the active analyser

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/voice-call-seams.ts:142-165`
- **Status:** resolved

`attachLevelAnalyser` registers a `track.addEventListener('ended', teardownLevelAnalyser, { once: true })` on every incoming track but never removes prior listeners. If renegotiation delivers a new track and the old track ends afterward, the old track's still-registered listener runs `teardownLevelAnalyser` on the _current_ (new) analyser/AudioContext, silently killing remote-level metering for the rest of the call.

### 2. `statsInterval` is not cleared when the peer wrapper closes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/voice-call-seams.ts:237-268, 284-295`
- **Status:** resolved

`wrapped.close()` calls `pc.close()` and `teardownLevelAnalyser()` but never `clearInterval(statsInterval)`. The interval only self-cancels by polling `pc.connectionState`; if the peer is closed before transitioning to `connected`/`failed`, or if `getStats()` rejects during the close window, the interval can keep re-firing on a closed peer. Deterministic teardown tied to the wrapper close would close the gap.

### 3. Multi-touch cancel does not release the captured pointer

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/CallGestureZone.svelte:21-41`
- **Status:** resolved

When a second pointer arrives, `clearGesture(ev.target, activePointerId)` is invoked with `ev.target` from the _new_ pointer event. `setPointerCapture` was previously called on the _original_ pointer's target, which may be a different child element under the gesture zone. `hasPointerCapture(oldId)` on the new target returns false, so `releasePointerCapture` is never called and the original element retains capture for the abandoned pointer until the browser implicitly releases it.

### 4. `iceconnectionstatechange` can fire `onPeerReady` for a stale session

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/stores/voice-call-seams.ts:227-233`
- **Status:** resolved

`onPeerReady(opts.getSessionId())` reads the _current_ store sessionId at firing time, not the one bound when this peer was created. If a delayed `connected`/`completed` state-change fires after a session swap, the stale peer can synthesize a `call_ready` for the wrong session. The store's `event.sessionId !== state.sessionId` filter bounds the impact, but the handler still emits a misleading event.

### 5. `currentPeer` never cleared after close

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/stores/voice-call-seams.ts:98, 284-298`
- **Status:** resolved

`currentPeer` is reassigned in every `createPeerConnection` call but never reset to `null` in `wrapped.close()`. Today the store always pairs `createPeerConnection` with `openSignaling`, so this is latent, but a future caller invoking `openSignaling` after teardown would silently bridge to a closed `RTCPeerConnection`.

### 6. `pendingInboundIce` ordering vs. concurrent message handlers

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/stores/voice-call-seams.ts:389-416`
- **Status:** resolved

Each WS message handler runs inside its own `void (async () => { … })()`. If `answer` and `ice` frames arrive back-to-back, both async IIFEs start immediately. The `ice` handler sees `remoteDescriptionSet === false` and pushes to `pendingInboundIce`; meanwhile the `answer` handler awaits `setRemoteDescription`, then drains the queue. With no mutual exclusion, an `ice` frame that arrives between the drain start and `remoteDescriptionSet = true` could either succeed directly or be queued and never drained again. Low likelihood given typical timing, but the handler relies on event-loop ordering rather than explicit synchronization.

### 7. `CallHeader` interval ticks unnecessarily while idle

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/CallHeader.svelte:21-29`
- **Status:** resolved

The 1Hz interval runs whenever `CallHeader` is mounted, even before `startedAt` is set (during `binding`/`connecting`). Harmless in steady state but wakes the runtime once a second for no visible effect; a real bug only if the component is mounted outside `CallingMode` (currently it is not).

### 8. `CallingMode` polls `getRemoteAudioLevel` every 100ms regardless of phase

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/CallingMode.svelte:11-17`
- **Status:** resolved

`getRemoteAudioLevel()` is invoked on a fixed 100ms interval irrespective of phase. During `binding`/`connecting` it returns 0; the cost is timer overhead, and there is no synchronization with the analyser's own 10Hz tick, so the UI may sample stale or missed values.

## No Issues

Plan adherence: no significant deviations found. All 12 steps landed as described, architectural contracts match (calling-mode subtree, gesture/audio cue semantics, `startedAt` lifecycle, `abortAgent` shape, `getRemoteAudioLevel` seam, `MessageList.readOnly`, `CallButton.variant`, `SessionSettingsDialog` row, `CallBanner` deletion, mobile header phone-button removal, codemap refresh), and the test files / interface files declared in the Tests section are unchanged since the pre-implementation commit.
