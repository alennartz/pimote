# DR-013: PWA-first voice client; Android / Android Auto deferred to v2

## Status

Accepted

## Context

The voice-mode brainstorm proposed an Android-first client using the telephony SDK (`SelfManaged ConnectionService`) so sessions would appear as contacts, Android Auto would work natively, and hardware answer/hangup/mute would come for free. That framing is still the right long-term direction.

But the plan identified a prior concern: the core hypothesis — _a single pi session can alternate system prompts and extension activation across calls without structural pi-SDK changes_ — had not been validated. Going Android-first would bury that validation behind a full mobile toolchain investment (Android Studio, Kotlin, Play Store / sideload distribution, ConnectionService quirks, Android Auto review process). A v1 failure there would be expensive and slow to diagnose.

The team's current owned toolchain is browser + TypeScript + SvelteKit. A PWA voice client rides on that existing toolchain with only `getUserMedia` + `RTCPeerConnection` + a WebSocket added.

## Decision

**v1 voice client is the PWA; Android / Android Auto / telephony SDK / sessions-as-contacts are explicitly v2.** This reverses the brainstorm's "PWA stays text-only in v1" decision.

The wire protocol (`call_bind`, `call_end`, `call_bind_response`, `call_ready`, `call_ended`, `call_status`) plus the speechmux signalling contract are designed to be **client-agnostic** — the v2 Android client consumes the same server interfaces without requiring protocol changes.

Rejected alternatives:

- **Android-first (brainstorm's original choice).** Defers hypothesis validation behind a mobile toolchain the team doesn't yet own. If the interpreter-pattern or extension-activation machinery doesn't work, we'd have spent the Android investment to learn that.
- **Native desktop client (Tauri / Electron).** Same toolchain gap as Android, no clear benefit over the PWA.

## Consequences

- v1 ships without hardware mute/hangup, call-history semantics, Android Auto integration, or "sessions as contacts." The PWA's in-call banner (mute + hangup) covers the minimum usable UX.
- Mic-permission prompt fires on first call in the PWA — a UX step the Android telephony path would have skipped.
- The single-owner session model means only one client at a time can own a call. The PWA indicator "voice call active on another device" (brainstorm's text-session behavior) is inherited for free; we did not build a multi-observer model.
- When v2 starts, the Android client implements the same `call_bind` / `call_ready` / `call_ended` / `call_status` protocol. The only new surfaces are Android-native (PhoneAccount registration, ContactsProvider sync, ConnectionService wiring) — none of which touch the pimote server or the voice extension.
- If the hypothesis fails in v1 (e.g., pi's extension-activation machinery proves inadequate), we find out cheaply and the fix lands in pi-SDK before we commit to Android. That's the whole point of the de-risk.
