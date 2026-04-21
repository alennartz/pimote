# Review: voice-mode

**Plan:** `docs/plans/voice-mode.md`
**Diff range:** `5fe18ee..HEAD` (filtered to exclude plan/review docs)
**Date:** 2026-04-21

## Summary

The plan was followed closely and all tests are green (server 243/243, client 325/325, @pimote/voice 40/40). Wire protocol, reducers, orchestrator, session-manager threading, ws-handler routing, UI-bridge gating, and client store/UI all land as planned. Test files are untouched from the pre-implementation commit.

However, two substantive bugs slipped past the test suite:

1. The registered `speak` tool's `execute` returns `isError: true` in every state, even though the surrounding code comments assume the `tool_call` hook short-circuits it — the pi-SDK hook can only **block**, not synthesize results, so active `speak()` calls return an error to the interpreter model.
2. The browser signalling seam opens the `/signal` WebSocket and sends `hello`, but never wires `offer`/`answer`/`ice` frames between the socket and the `RTCPeerConnection`, so there is no WebRTC handshake (plan Step 8 explicitly required the full handshake).

A handful of lower-severity issues follow. Plan adherence is otherwise faithful.

## Findings

### 1. `speak` tool always returns `isError: true` when invoked

- **Category:** code correctness
- **Severity:** critical
- **Location:** `packages/voice/src/index.ts:179-201` (`registerTool` + `tool_call` hook)
- **Status:** resolved

Plan Step 4 expected the `tool_call` hook to return `{ action: 'handled', result: { success: true } }` so the tool's `execute` never runs while `state === 'active'`. The `ToolCallEventResult` interface in pi-SDK (`dist/core/extensions/types.d.ts:644`) only supports `{ block?: boolean; reason?: string }` — there is no `action: 'handled'` surface. The implementation acknowledges this in a comment and returns `undefined` from the hook, but then leaves the registered tool's `execute` returning `isError: true` with the message _"speak() is only available during an active voice call."_ unconditionally. So when `speak()` is called during an active call:

- The hook streams the token to speechmux (good).
- The tool then executes and returns an error result to the model (bad).

The interpreter will see every speak call fail, which will likely trigger retries, apologies, or confused behavior. The fix is for `execute` to inspect the captured `runtime` closure and return a trivial success result when `state === 'active'`. This was not caught by tests because `extension-runtime.test.ts` exercises only the pure reducers and `index.test.ts` only asserts hook registration, not the tool-result path.

### 2. WebRTC signalling handshake is not wired

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `client/src/lib/stores/voice-call-seams.ts:77-128` (`openSignaling`)
- **Status:** resolved (scaffolding — full `hello → session → offer/answer → ice → bye` handshake wired; untested against live speechmux, see `docs/manual-tests/voice-mode.md`)

Plan Step 8 required `openSignaling` to "route offer/answer/ice through the `RTCPeerConnection` (full `hello → session → offer/answer → ice → bye` handshake per `speechmux/src/webrtc_transport/signaling.rs`)". The implementation sends `{type:'hello', token}` on open and parses inbound JSON into listeners, but:

- Nothing subscribes to those listeners to feed `offer` / `answer` / `ice` frames into `pc.setRemoteDescription` / `pc.addIceCandidate`.
- The peer connection never emits its local `icecandidate` / `negotiationneeded` back over the socket.
- There is no `session`/`bye` framing.

As a result, `getUserMedia` succeeds, tracks are added to the peer, but the peer will never complete ICE — the local `iceConnectionState === 'connected'` path (which drives the store's transition to `connected` via `onPeerReady`) cannot fire without an actual offer/answer exchange. The whole real-speechmux smoke depends on this code. It was not caught because `voice-call.svelte.test.ts` uses in-memory seams that don't model the handshake, and the mock-speechmux smoke script exercises only call-bind/call-end, not WebRTC.

The plan's Step 14 notes real-speechmux smoke is blocked externally, so this may have been deferred intentionally — but nothing in the commits or docs flags it as incomplete. At minimum this should be tracked as a known gap in `docs/manual-tests/voice-mode.md`.

### 3. `bindCall` succeeds when speechmux is disabled, emitting activate with empty URL

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/voice-orchestrator-boot.ts:82-97` (`mintCallToken`) + `server/src/voice-orchestrator.ts:105-132` (`bindCall`)
- **Status:** resolved

Plan Step 6 specified: _"If `config.voice?.speechmuxBinary` is unset, `start()` is a no-op and the orchestrator stays disabled; `bindCall` will fail with `call_bind_failed_internal`."_

Actual behavior: `startSpeechmux` warns and returns without setting a disabled flag; `mintCallToken` unconditionally returns `{token: randomUUID(), turn: {urls: [], username: '', credential: ''}, webrtcSignalUrl: config.voice?.speechmuxSignalUrl ?? ''}` regardless of configuration; `bindCall` therefore succeeds and emits `pimote:voice:activate` with `speechmuxWsUrl: ''` and empty TURN creds to the session's EventBus. The voice extension then tries to open a WebSocket to `''` and fails.

Symptoms: misleading success response to the client, extension churn on every call bind, and a gap between what the config controls imply and what actually happens. The fix is a guard in `bindCall` (or in `mintCallToken` / boot) that throws `call_bind_failed_internal` when `config.voice?.speechmuxBinary` / `speechmuxSignalUrl` / `speechmuxLlmWsUrl` are unset.

### 4. Duplicate `endCall` on displacement path

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1059-1075` (private `displaceOwner`) and `server/src/ws-handler.ts:1260-1272` (`sendDisplacedEvent`)
- **Status:** resolved

Both the new-owner's `displaceOwner` method and the old-owner's `sendDisplacedEvent` call `voiceOrchestrator.endCall({ sessionId, reason: 'displaced' })`. `endCall` is idempotent so the second invocation is a no-op, but the two-site teardown makes the intent hard to follow and invites a future regression if one site stops calling `endCall`. Also: the old owner receives `call_ended { displaced }` from `sendDisplacedEvent`, while the new owner's `displaceOwner` emits nothing to the old client — good, but subtle. Consolidate the voice teardown into a single site (prefer `sendDisplacedEvent`, since that's where the old-owner's event actually goes).

### 5. Race between `SpeechmuxClient` factory return and `onFrame` subscription

- **Category:** code correctness
- **Severity:** warning
- **Location:** `packages/voice/src/speechmux-client.ts:75-100` + `packages/voice/src/index.ts:84-96`
- **Status:** resolved

The default factory installs `ws.on('message', …)` after the `hello` frame is sent and resolves the factory promise. The outer action executor then awaits the factory and only afterwards calls `client.onFrame(listener)`. Any `user`/`abort`/`rollback` frame speechmux sends in that window (between `hello` write and `onFrame` registration) is parsed by the internal handler but dropped because `listeners` is still empty. In practice speechmux probably doesn't send frames before it sees the first harness token, but it's an unbounded dependency on speechmux's own internal timing. Safer: buffer frames inside the factory until the first `onFrame` listener is attached, or have the factory accept an initial listener.

### 6. `voice-orchestrator-boot.ts` clientRegistry late-binding via `Proxy`

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/index.ts:39-53`
- **Status:** resolved

The orchestrator needs a `clientRegistry` at construction time, but the registry is created inside `createServer`. The workaround is a `Proxy` over an empty `Map` that forwards all gets to a mutable `clientRegistryRef.current`, which is replaced after `createServer` returns. It works for the current usage (`registry.get(clientId)`) but:

- `Proxy` over `Map` is fragile — `Map.prototype.get` needs its receiver bound to the real Map, and `Reflect.get(target, prop, target)` only accidentally produces the right `this`. Any future code that does `new Map(proxy)` or spreads it will misbehave.
- The intent is not obvious from the call site.

A plain forward-declared object (`{ get: (id) => clientRegistryRef.current.get(id) }`) typed as `ClientRegistry` interface (or restructuring `createServer` to accept the orchestrator constructor separately) would be clearer and less error-prone.

### 7. `call_ended` never emitted to the caller of `call_end` on the same handler

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/ws-handler.ts:588-593` (`case 'call_end'`)
- **Status:** dismissed (v1 single-call-per-session model; explicitly low-risk per review; revisit if multi-client-per-session lands)

The `call_end` handler sends `call_ended { reason: 'user_hangup' }` to the calling client via `sendEvent`, which is fine. However, if another client on the same session also has the call open (e.g., via `handleServerEvent` routing), only the caller gets the event. This is consistent with v1's single-call-per-session model, but worth noting since the orchestrator-side `endCall` doesn't broadcast. Low risk.

### 8. `mintCallToken` ignores sessionId and doesn't register with speechmux

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `server/src/voice-orchestrator-boot.ts:82-97`
- **Status:** resolved (partial — TODO annotation tying to speechmux external blocker; full POST stays blocked on speechmux)

Plan: _"`mintCallToken(sessionId)` — v1: generate a random token (`crypto.randomUUID()`), POST it to speechmux's admin endpoint (contract owned by speechmux; see External dependencies)."_

Implementation: generates the token but never POSTs anywhere and doesn't use `sessionId`. The plan flags this as blocked on speechmux's per-call-auth work, so not flagging as critical — but there's no TODO/warning log tying it to the external blocker, making it easy to forget.

## No Issues

- **Test immutability:** `packages/voice/src/walk-back.test.ts`, `packages/voice/src/extension-runtime.test.ts`, `server/src/voice-orchestrator.test.ts`, `server/src/extension-ui-bridge.test.ts`, and `client/src/lib/stores/voice-call.svelte.test.ts` are all byte-identical between `5fe18ee` and HEAD. The plan's test-immutability guarantee held.
- **Walk-back surgery:** `packages/voice/src/walk-back.ts` and its test are untouched from the test-write phase; the `context` hook wiring in `index.ts` matches the plan contract (clears watermark + captured after applying; triggers even while not active if a watermark is set).
- **Interpreter prompt:** adapted from voxcoder with `{{workerProvider}}` / `{{workerModel}}` placeholders, substituted at factory time per plan Step 2.
- **Extension runtime reducers:** match the plan's action DSL and state machine exactly (activate → activating, opened → active w/ one-shot set_model + sentinel, failure → dormant + deactivate, deactivate → dormant + close + clear; frame routing ignores frames while not active).
- **UI-bridge gating:** `ws-handler.ts` passes `{ isVoiceModeActive: () => orchestrator.isCallActive(sessionId) }` on both `claimSession` and `handleSessionReset`, as planned.
- **Client UI:** `CallButton` + `CallBanner` components match Step 10/11 behavior (disabled-while-in-use rules, mute wiring through `setMicrophoneEnabled`, layout mount in `+layout.svelte`).
