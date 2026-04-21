# DR-012: Speechmux sidecar with WebRTC over Cloudflare Realtime TURN

## Status

Accepted

## Context

Voice-mode needs full-duplex audio (STT + TTS + VAD + barge-in) and NAT-traversable transport between the client and the voice engine. Several options were available:

- **Speechmux** — an existing project the team already owns. Its WS `LlmBackend` protocol lets an external process play the "LLM" role and receive content-precision `rollback{heard_text}` frames on barge-in. WebRTC transport with Cloudflare Realtime TURN is already implemented and tested.
- **Browser Web Speech APIs** (`SpeechRecognition` / `SpeechSynthesis`).
- **Cloud ASR/TTS SDKs** (e.g., Deepgram + ElevenLabs, Azure Speech, etc.).
- **Self-hosted coturn** or **peer-to-peer-only** for transport.

## Decision

**Speechmux is the voice engine, run as a sidecar process supervised by pimote's `VoiceOrchestrator`.** Pimote plays the "LLM" role on speechmux's WS seam, so the voice extension translates speechmux frames into pi SDK calls (`user` → `sendUserMessage`, `abort`/`rollback` → `session.abort()` + walk-back).

**Audio transport is WebRTC over Cloudflare Realtime TURN**, reusing speechmux's existing DR-013 mint flow.

Rejected alternatives:

- **Browser Web Speech APIs.** No barge-in discipline (no content-precision cutoff, no rollback frame), no engine reuse for a future Android client, quality varies wildly across browsers. Rejected.
- **Cloud ASR/TTS directly from the client.** Adds per-hop latency, per-minute cost, and loses the barge-in-with-`heard_text` hook that speechmux already provides. Rejected.
- **Self-hosted coturn.** Operational burden (deployment, scaling, monitoring) without a corresponding win over Cloudflare's managed TURN. Rejected.
- **Peer-to-peer-only (no TURN).** NAT traversal is unreliable on cellular networks — the primary voice-mode target is the driving / Android Auto scenario. Rejected.

## Consequences

- Pimote gains a subprocess supervisor responsibility it didn't have before. `VoiceOrchestrator.start`/`stop` owns the speechmux lifecycle; absence of `voice.speechmuxBinary` disables voice gracefully but leaves other pimote features working.
- The WS `LlmBackend` protocol becomes the contract boundary between pimote and speechmux. Any changes to speechmux's frame shapes ripple into `packages/voice/src/speechmux-client.ts` and the extension-runtime reducers.
- Two speechmux-repo changes are prerequisite for real end-to-end smoke: (1) lift the WS `LlmBackend` listener out of the per-call loop so it binds at startup; (2) replace the single shared env token on `/signal` with per-call auth tokens minted by pimote. These are external blockers — the pimote side uses injected seams (`startSpeechmux`, `mintCallToken`, `SpeechmuxClientFactory`) so unit tests and the mock-speechmux smoke don't depend on them.
- Cloudflare Realtime TURN billing/quota becomes a production concern. TURN creds are minted per call by speechmux's existing flow.
- Concurrent calls require one speechmux per call (speechmux has a single-call-slot-per-process). Acceptable for v1's single-user scope.
