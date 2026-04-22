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
- The two speechmux-side prerequisites for real end-to-end voice have both landed: (1) speechmux DR-015 lifts the `LlmBackend` listener out of the per-call loop so it binds at startup; (2) speechmux DR-016 adds a session watchdog so orphan peers are reaped after 10s. The pimote side still uses injected seams (`startSpeechmux`, `SpeechmuxClientFactory`) so unit tests and the mock-speechmux smoke don't depend on a real sidecar.
- Auth on `/signal` is delegated to Cloudflare Access at the edge (speechmux runs in fail-open mode with `WEBRTC_AUTH_TOKEN` unset). Pimote no longer mints or proxies a per-call auth token — the PWA sends a hello frame with no token field and Cloudflare Access gates the connection upstream.
- Cloudflare Realtime TURN billing/quota becomes a production concern. Per-session TURN credentials are minted by speechmux and delivered to the PWA directly in its `/signal` `session` response; pimote's `CallBindResponse` carries only the WebRTC signalling URL.
- Concurrent calls require one speechmux per call (speechmux has a single-call-slot-per-process). Acceptable for v1's single-user scope.
