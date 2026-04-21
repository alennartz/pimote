# Manual Testing — voice-mode

Follow-up artifact for the `voice-mode` topic. The initial manual-test
pass (commit `ab968e9`, artifact now in git history) drove journey 8's
server-side half with `scripts/voice-mock-smoke.mjs` and punted the PWA
half to a code-path audit (T3, "Browser automation gap"). The artifact
itself was removed in the subsequent cleanup commit `060a5c1`; this
file is re-created to record the re-test pass that closes that gap.

## Re-test (2026-04-21)

**Scope:** PWA side of journey 8 only — the mock-speechmux smoke, the
real-speechmux E2E (still externally blocked), and the T3 code-path
audit are covered by the prior pass / its `scripts/voice-mock-smoke.mjs`
invariants.

### Tools

- **Reused:** `scripts/voice-mock-smoke.mjs` (prior run — not re-executed
  this pass, invariants unchanged).
- **Reused (cross-repo):** `agent-browser` skill — invoked as the
  journey-8 PWA driver per the mandatory-reuse table in the
  manual-testing skill. Registered in `tools/manual-test/README.md` this
  run.
- **New:** none.
- **Improved:** none.

### Setup

1. Isolated config + state:
   ```bash
   export XDG_CONFIG_HOME=/tmp/pimote-retest/config
   export XDG_STATE_HOME=/tmp/pimote-retest/state
   ```
   `config.json` with a sandboxed root (`/tmp/pimote-retest/root`) and a
   stub `voice` block — `speechmuxBinary: /bin/true`,
   `speechmuxSignalUrl: ws://127.0.0.1:59999/signal`,
   `speechmuxLlmWsUrl: ws://127.0.0.1:59999/llm`. The binary path has to
   exist (so `spawn` succeeds and `mintCallToken`'s config guard is
   satisfied); the signal URL is deliberately dead so the call fails
   past the PWA UI at the speechmux signalling step, which is the
   expected env (no real speechmux) and what we want to observe.
2. `node bin/pimote.js --port 4568` in the background.
3. `agent-browser open http://localhost:4568/` → `snapshot -i` →
   follow refs.
4. Browser-side shim: `getUserMedia` replaced with a real
   `MediaStreamAudioDestinationNode.stream` so `RTCPeerConnection.addTrack`
   accepts the track. Headless Chromium has no mic; no browser flag in
   `agent-browser` to route a fake device through to WebRTC, so the
   replacement is done via `agent-browser eval`.

### Results

| #   | What was driven via `agent-browser`                                          | Observed                                                                                                                                                                                                                                                                                                      | Verdict      |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | Create project, open new session in status-bar.                              | Session card renders; status-bar shows `button "Start voice call" [aria-label=Start voice call]`. Matches `StatusBar.svelte:94` mounting `<CallButton>`. Screenshot: `20-pre-call.png`.                                                                                                                       | pass         |
| 2   | `click @<call-button>` → snapshot.                                           | Banner appears with `text: Connecting…`, `button "Mute"`, `button "End call"`. Server log confirms WS frame round-trip (client reconnect + session open, no `call_bind_failed_*` warning). Screenshot: `21-in-call-banner.png`. Only _after_ the inline fix below did the banner render — see _Fixed inline_. | fixed-inline |
| 3   | `click @<end-call>` → snapshot.                                              | Banner unmounts; status-bar `Start voice call` button returns. `onHangup` in `CallBanner.svelte` invokes `voiceCallStore.endCall()`; the `connection.onEvent` listener receives `call_ended { reason: 'user_hangup' }` from the server and transitions state → `idle`. Screenshot: `22-post-hangup.png`.      | pass         |
| 4   | Second call → banner re-renders with mute + hangup; hangup tears down again. | Banner with `Mute` + `End call` renders; End-call click returns UI to idle. Confirms the bind → teardown → re-bind cycle works through the UI without a reload. Screenshot: `23-muted-banner.png`.                                                                                                            | pass         |

T3 ("PWA code-path audit") from the prior pass is now verified by live
UI interaction — the Call button actually clicks, `call_bind` actually
round-trips, and the in-call banner actually mounts with mute + hangup
controls wired to `voiceCallStore.toggleMute()` / `voiceCallStore.endCall()`.

### Fixed inline

**voice-call store state was not reactive.** `VoiceCallStore.state` in
`client/src/lib/stores/voice-call.svelte.ts` was declared as a plain
class field:

```ts
state: VoiceCallState = { phase: 'idle', ... };
```

with a comment _"In production this is a $state() rune"_ — but the rune
had been dropped at some point in the rework. `CallBanner.svelte`'s
`$derived(voiceCallStore.state)` therefore never re-derived when
`startCall`/`endCall`/`handleServerEvent` mutated `this.state`, so the
banner stayed at `phase === 'idle'` forever and never rendered. Unit
tests (17/17) passed because they read the state field directly after
each mutation and never exercised Svelte reactivity.

Fix: add the rune so the assignment stays identical but the field
becomes reactive.

```ts
state: VoiceCallState = $state({ phase: 'idle', ... });
```

After the fix: banner mounts on click, phase label flips, and hangup
unmounts the banner. All 17 voice-call unit tests still green.

This is the defect T3's code-audit-only approach couldn't catch — a
straightforward reactivity regression only observable by mounting the
component and actually clicking through the flow. Strong argument for
keeping `agent-browser` on journey 8 from here on.

### Open Issues

- **Real-speechmux E2E (journey 8 → T2) still externally blocked** on
  the two speechmux-repo changes documented in the prior pass
  (startup-time `LlmBackend` listener; per-call auth tokens on
  `/signal`). Unchanged this run.
- **`getUserMedia` in headless Chromium.** This run patched it via
  `agent-browser eval` with a real `MediaStreamAudioDestinationNode`
  stream; a more durable approach is to launch agent-browser with
  `--use-fake-device-for-media-stream` when it supports Chromium-flag
  passthrough. Not a blocker — the current shim is sufficient and
  ~5 lines — but worth registering as a small follow-up if future
  voice-mode tests want a cleaner setup.
