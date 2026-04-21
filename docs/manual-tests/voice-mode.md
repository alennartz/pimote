# Manual test: voice mode

Checklist for the end-to-end voice-mode smoke (plan Step 14). The real
speechmux end-to-end smoke is **blocked** on speechmux-repo changes:

- Lift the WS `LlmBackend` listener out of the per-call loop so it binds at
  startup and survives across calls.
- Replace the single shared env token on `/signal` with per-call auth
  tokens minted by pimote's orchestrator.

Until those land, the section below documents the pimote-side pieces that
are testable **now** (with a mock speechmux) and the full smoke that will
run once speechmux is ready.

## Mock-speechmux smoke (runnable today)

Script: `scripts/voice-mock-smoke.mjs` (companion to this doc). Exercises
the pimote-repo pieces without a real speechmux:

1. Starts pimote server with `voice.speechmuxBinary=/bin/sleep`,
   `voice.speechmuxLlmWsUrl=ws://127.0.0.1:0/mock`,
   `voice.speechmuxSignalUrl=ws://127.0.0.1:0/mock`.
2. Connects a WS client that sends `call_bind` + `call_end` and asserts
   `call_bind_response` / `call_ended` round-trips.
3. Confirms `isVoiceModeActive` gates UI bridge dialogs via an
   extension-registered probe.

Run:

```bash
node scripts/voice-mock-smoke.mjs
```

## Real speechmux smoke (blocked)

**Status of the browser signalling bridge:** `client/src/lib/stores/voice-call-seams.ts`
now implements the full `hello → session → offer/answer → ice → bye`
speechmux signalling handshake (envelope format `{v:1, type, payload}`), wires
local `onicecandidate` → outbound `ice` trickle, and routes inbound
`answer` / `ice` into `pc.setRemoteDescription` / `pc.addIceCandidate`. The
scaffolding is in place but has **not** been exercised against a live
speechmux — expect small correctness adjustments (SDP munging, end-of-
candidates semantics, TURN creds source-of-truth) to be needed on first
real smoke run.

With the speechmux-repo changes landed:

1. Start pimote server with `voice.*` config pointing at a local speechmux.
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

**Status:** blocked — waiting on speechmux LlmBackend listener refactor +
per-call auth tokens on `/signal`.
