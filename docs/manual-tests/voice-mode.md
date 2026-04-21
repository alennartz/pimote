# Manual Testing — voice-mode

Autoflow manual-test artifact for the `voice-mode` topic. Extends the
original checklist (Step 14 of `docs/plans/voice-mode.md`) with the
skill's standard sections. The real-speechmux end-to-end run remains
blocked on speechmux-repo work; the pimote-side behaviour is exercised
by `scripts/voice-mock-smoke.mjs` and the PWA walk-through below.

## Smoke Suite

`tools/manual-test/PLAN.md` journey **8 — Voice call (bind, in-call,
hangup)** is the only journey this topic owns. Journeys 1–7 of the
persistent plan predate this topic and have no automation driver; they
are outside the voice-mode scope and were not re-exercised in this run.

- Journey 8: voice-mock-smoke (automated) — **pass** (assertions below).
- Journey 8, PWA side: manual-browser walk-through — **externally
  blocked** on real speechmux; deferred to the pimote ↔ speechmux
  integration run. The PWA code paths are covered by the in-env code
  audit below.

## Topic-Specific Tests

### T1 — Mock-speechmux smoke (pimote-only, automated)

Exercises the orchestrator, extension-runtime reducers, wire-shape of
`call_bind` response, displacement seam, UI-bridge predicate, and
`call_ended` reason-code handling — all without a real speechmux.

Driver: `scripts/voice-mock-smoke.mjs` (extended this run; see
_Tools → Improved_).

### T2 — Real-speechmux end-to-end smoke (externally blocked)

Checklist for the live run once speechmux-repo changes land. Not
runnable today. See _Open Issues_.

### T3 — PWA code-path audit (in-env manual scrutiny)

With no browser available in this environment, the PWA side of
journey 8 is exercised by direct code inspection against the plan's
contract. Captures wiring that the automated tests cover in isolation
but not as an end-to-end path.

## Tools

- **Reused:** none — no pre-existing tools under `tools/manual-test/`.
- **New:** `tools/manual-test/PLAN.md` and `tools/manual-test/README.md`
  bootstrapped this run (first autoflow topic to land manual-test
  scaffolding; see _Plan Updates_).
- **Improved:** `scripts/voice-mock-smoke.mjs` extended from the
  implement-phase baseline with:
  - `call_bind_failed_session_not_found` + `call_bind_failed_owned`
    error-path assertions.
  - Force-displacement path: second `bindCall` with `force:true`
    invokes `displaceOwner`, emits deactivate + fresh-token activate,
    leaves exactly one active call with a new token.
  - UI-bridge gating predicate assertions (`isVoiceModeActive`
    transitions true during call → false after `endCall`, mirroring
    the predicate ws-handler.ts passes to `createExtensionUIBridge`).
  - `endCall` idempotency and unbound-session no-op assertions.

## Results

### T1 — Mock-speechmux smoke

**What was run:**

```bash
npm run build
node scripts/voice-mock-smoke.mjs
```

**Observed:** 32/32 assertions pass across six blocks — orchestrator
lifecycle, `bindCall` → `pimote:voice:activate` (shape, token, TURN
creds), extension-runtime reducers (activate / speechmux-opened /
speechmux user & rollback frames → `send_user_message` / `abort` /
`set_walkback_watermark` / `append_custom_entry` with the correct
`kind`), UI-bridge predicate transitions, `endCall` →
`pimote:voice:deactivate` with idempotency, `bindCall` error codes,
force-displacement emits the right bus events and respects ownership.

**Verdict:** **pass**.

### T2 — Real-speechmux end-to-end (checklist, blocked)

With the speechmux-repo changes landed (startup-time `LlmBackend`
listener + per-call tokens on `/signal`):

1. Start pimote server with `voice.*` config pointing at a local
   speechmux binary.
2. Open a session in the PWA; click **Call**.
3. Confirm:
   - `call_bind` round-trips with TURN creds;
   - `getUserMedia` prompts;
   - `/signal` WS opens;
   - WebRTC peer connects (`iceConnectionState === 'connected'`);
   - banner flips to **connected**.
4. Speak; speechmux transcribes → `{type:'user', text}` arrives on the
   LlmBackend WS; interpreter responds with `speak(...)` tool calls;
   text streams back as audio.
5. Barge in: confirm speechmux sends `{type:'rollback', heard_text}`;
   confirm the next LLM turn's `context.messages` has been
   walk-back-surgeried (observable via an instrumentation log or by
   inspecting the persisted session's `pimote:voice:interrupt` entries).
6. Hang up; confirm `call_ended`; confirm the UI bridge is re-enabled
   (run a pi extension dialog command and observe it resolves normally).
7. Displace: start a second call on the same session with `force: true`
   from a different browser — confirm the first client gets
   `call_ended { reason: 'displaced' }` and the extension's deactivate
   reducer ran (speechmux client closed).

**Status of the browser signalling bridge:**
`client/src/lib/stores/voice-call-seams.ts` implements the full
`hello → session → offer/answer → ice → bye` speechmux signalling
handshake (envelope `{v:1, type, payload}`), wires local
`onicecandidate` → outbound `ice` trickle, and routes inbound `answer`
/ `ice` into `pc.setRemoteDescription` / `pc.addIceCandidate`. The
scaffolding is in place but has not been exercised against a live
speechmux — expect small correctness adjustments (SDP munging,
end-of-candidates semantics, TURN creds source-of-truth) to be needed
on first real smoke run.

**Verdict:** **open** — externally blocked (see Open Issues).

### T3 — PWA code-path audit (in-env manual scrutiny)

**What was run:** direct inspection of the client-side voice-mode
wiring against the plan's contract. No browser, no mock server —
focus areas per the autoflow invocation task.

**Observed:**

- **Call button on sessions.** `StatusBar.svelte:94` mounts
  `<CallButton sessionId={sessionRegistry.viewed?.sessionId} />`.
  `CallButton.svelte` disables the button when no session is viewed or
  when a call on a _different_ session is active; otherwise clicking it
  calls `voiceCallStore.startCall(sessionId)`. Matches journey 8 step 1.
- **Call bind round-trip.** `voice-call.svelte.ts` `startCall` sends a
  `call_bind` command via the injected `sendCommand` seam, transitions
  `idle → binding → connecting`, requests `getUserMedia`, creates the
  peer connection, and opens the speechmux signalling WS with the
  returned `callToken`. Covered by 17 unit tests in
  `voice-call.svelte.test.ts`.
- **In-call banner with mute + hangup.** `+layout.svelte:277` mounts
  `<CallBanner />` above the main content. `CallBanner.svelte` renders
  only when `state.phase !== 'idle'`, shows phase-specific labels
  (including `muted` suffix when `micMuted`), exposes mute/unmute and
  hangup buttons wired to `voiceCallStore.toggleMute()` /
  `voiceCallStore.endCall()`. Last-error is displayed when set.
  Matches journey 8 steps 3–4.
- **Hangup tears down.** `endCall` sends `call_end`, transitions to
  `ending`, runs local teardown (peer close, media tracks stopped,
  signalling closed) even if the server command fails, and resets to
  `idle`. Covered by unit tests (`endCall idempotency and
local-teardown-on-command-failure`).
- **Event routing.** `voice-call-store.ts` subscribes once to
  `connection.onEvent` at module import, routing
  `call_ready`/`call_ended`/`call_status` to
  `voiceCallStore.handleServerEvent`. Also synthesises
  `call_ended { reason: 'displaced' }` when `session_closed { reason:
'displaced' }` arrives for the session currently under a call, so
  the local store tears down in-sync with server-side displacement.
  Imported as a side-effect from `+layout.svelte:10` at app boot.
- **UI-bridge gating in ws-handler.** `ws-handler.ts:1097` and `:1138`
  pass `isVoiceModeActive: () => voiceOrchestrator.isCallActive(id)`
  into `createExtensionUIBridge`. The predicate is re-evaluated on
  every dialog call (confirmed in `extension-ui-bridge.ts:29`), so
  toggling voice-mode between calls re-enables dialogs on the same
  bridge instance. Covered by unit tests in
  `extension-ui-bridge.test.ts` and exercised end-to-end against real
  orchestrator state in the mock smoke (T1).

**Verdict:** **pass** (code-path audit). The live PWA walk-through
remains gated on real speechmux (T2); no PWA-side defects found during
the audit that would affect the mock-speechmux surface.

## Plan Updates

- **Added journey 8 "Voice call"** to `tools/manual-test/PLAN.md`
  (bootstrap + new journey in the same commit, since this is the first
  autoflow topic to establish the persistent plan).

## Open Issues

- **Real speechmux end-to-end smoke (T2) blocked** on two
  speechmux-repo changes:
  1. Lift the WS `LlmBackend` listener out of the per-call loop so it
     binds at startup and survives across calls.
  2. Replace the single shared env token on `/signal` with per-call
     auth tokens minted by pimote's orchestrator.
     Until those land, T2 steps 3–7 (live WebRTC handshake, STT/TTS
     round-trip, barge-in walk-back on live audio, hangup-reenable of
     the UI bridge with a live extension, cross-browser displacement on
     a live call) are unexercised against a live speechmux. Tracked as
     speechmux-repo work; not an open item inside pimote-repo.
- **Android telephony / Android Auto** are explicitly v2 per the plan.
  Not encountered in this run; noted here for traceability.
- **Session-kind persistence.** Voice-mode sessions are not
  distinguished from regular sessions on disk in v1 — they behave as
  normal sessions after a call ends. Confirmed against the code
  (`session-manager.ts` does not persist a voice flag, and the
  orchestrator's `activeCalls` is in-memory). Consistent with the
  plan; not a defect.
- **Browser automation gap.** The PWA side of journey 8 (and every
  other persistent journey) has no automation driver. `T3` audits the
  wiring but does not click the UI. Introducing a browser-automation
  harness is out of scope for this topic and recorded in
  `tools/manual-test/PLAN.md`'s _Automation gap_ section.
