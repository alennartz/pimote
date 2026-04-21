# Brainstorm: Voice mode — Android v2

## Context

Voice-mode v1 (PWA-first) shipped deliberately narrow: outbound voice from the browser only, no Android, no agent-initiated calls. This topic plans the v2 Android client. It is **not** a from-scratch brainstorm — most of the structural decisions were made and documented during voice-mode v1 (DR-011 through DR-014) and scoped as "Android deferred to v2." This file collects those v1 v2-intended decisions, preserves them as the starting point for v2, and integrates any useful ideas from speechmux's pre-existing `docs/brainstorms/android-auto-agent-calling.md` (a speechmux-side Android product brainstorm that partially overlaps but diverges on key architectural choices — notes below).

## Settled starting points (from pimote voice-mode v1)

These decisions are carried forward from voice-mode v1 and should not be re-litigated in v2 unless v1 experience has undermined their reasoning:

- **Android is a pimote WS client _plus_ a WebRTC peer.** Two connections: (a) the existing pimote client-server WS protocol for control/signaling/session discovery, (b) a WebRTC leg direct to speechmux's publicly-reachable `/signal` endpoint. No new control plane. (DR-013 consequence)
- **Telephony SDK, not media SDK.** Use `SelfManagedConnectionService`. Calls are WebRTC under the hood but registered with Android telecom, which gives Android Auto integration for free: native "call [contact]" voice commands, hardware answer/hangup/mute, call history, missed-call semantics. No PSTN, no SIP provider.
- **Sessions-as-contacts.** Each pimote session is a `PhoneAccount`; each project has a `*new session in <project>*` hotline contact. Android Auto's native contact picker _is_ the session picker. No custom Auto UI needed.
- **`PhoneAccount` registration is the source of truth for v1 Android** (no ContactsProvider sync). If Google Assistant voice-command fidelity proves inadequate, add ContactsProvider sync later. (Pimote v2 decision — from the voice-mode architect phase.)
- **Call signaling rides the existing pimote protocol.** `call_bind` / `call_end` / `call_ready` / `call_ended` / `call_status` are already implemented and in use by the PWA. The Android client consumes the exact same interfaces.
- **Per-call auth tokens** are minted by pimote and handed to both the Android client and speechmux. Speechmux-repo work (see [`/home/alenna/repos/speechmux/docs/brainstorms/pimote-harness-integration.md`](../../../speechmux/docs/brainstorms/pimote-harness-integration.md)) adds the per-call token surface; v2 Android consumes it.
- **Single-owner displacement model.** Android dialing a session displaces the current owner (PWA or another phone) with `session_closed{reason:'displaced'}`. When the call ends, ownership is released. Sequential modality switching (car → laptop → phone) is handled by displacement; concurrent coexistence is deferred further (v3).
- **Voxcoder's hands-free prompt patterns** are already encoded in the interpreter prompt shipped in v1 (`packages/voice/src/interpreter-prompt.ts`). Android v2 inherits them unchanged; driving-specific prompt polish is prompt-engineering, not architecture.
- **The interpreter-as-primary + `my-pi` subagent workers topology** (DR-011) is unchanged. The Android client is a peer to the PWA — a different entry point into the same session.

## New v2-specific questions

v1 deliberately stopped short of these. v2 owns them.

### 1. Agent-initiated (incoming) calls

Speechmux's android-auto brainstorm lists bi-directional calling as "core to the use case." Pimote v1 scoped agent-initiated calls out entirely; notifications stayed as web-push only. For v2 this becomes a real decision:

- **Mechanism.** FCM (Firebase Cloud Messaging) is the obvious trigger — the server wakes the Android app which then presents a `CallStyle` notification via the existing `PimoteConnectionService` and the user answers it just like any incoming call. Pimote's existing push payload schema already has an `interaction` variant; adding `call` is straightforward (noted in v1 as "cheap on the server side").
- **Trigger policy.** When does the agent call? Voxcoder-style: "long task completed and I need you to weigh in." Must be user-controlled per session or per project ("call me if the deploy fails," "don't call me for test-only changes"). Easy to get wrong — annoying-notifications-at-scale.
- **Retry / missed-call semantics.** Pulled from speechmux's open questions: _"Final retry/missed-call policy semantics for agent-initiated calls (initial options discussed, not locked)."_ Decide when the agent gives up, whether it leaves a "voicemail" (a push notification with the message), whether it retries after some interval.
- **Ring behavior in Android Auto.** Needs specific thought — drivers shouldn't get interrupted at inappropriate moments; Do-Not-Disturb integration and per-time-of-day policy may be necessary.

### 2. Session identity model — "persistent Agent" vs "sessions as contacts"

Speechmux's brainstorm chose a **single persistent "Agent" contact** for MVP; pimote's v1 decided **each session is a contact** (plus per-project `*new session*` hotlines). These are in tension.

v1's "sessions as contacts" was designed for a world where the user knows which session to call ("call cleanup-refactor" vs "call test-debugging"). This matches how the user already thinks about pi sessions from the PWA. But it has real costs:

- Many `PhoneAccount` registrations clutter the dialer / Android Auto contact picker, especially for users with lots of historical sessions.
- Session lifecycle (fork, switch, tree-navigate) generates new session IDs; naive `PhoneAccount` sync churns contacts on every navigation.

Options for v2:

- **(A) Keep sessions-as-contacts as designed.** Accept the clutter; only register active / recent sessions as contacts (bounded LRU). Deregister idle sessions to keep the list short.
- **(B) Adopt speechmux's "one Agent" model.** Single persistent contact; voice commands always target "the Agent"; session context is disambiguated inside the call (_"which project?" / "which session?"_). Simpler Android setup, harder in-call UX, loses the Auto-native contact-picker-as-session-picker win.
- **(C) Hybrid.** One `*Agent*` primary contact (per user? per account?) for general voice-command targeting, _plus_ project-level hotlines for explicit project targeting. Recent sessions surface through call history rather than contacts list. Probably the pragmatic answer but adds complexity.

Worth deciding at architect phase after some real driving / Auto use with a PWA-only v1 informs intuition.

### 3. Voice-invocation reliability

Speechmux's brainstorm phases voice invocation deliberately: _"reliable Telecom/manual flow first, then harden true Assistant 'Call Agent' behavior."_ This is good phasing advice for us too — Google Assistant's ability to say "Ok Google, call [X]" maps reliably to `PhoneAccount` labels for _some_ values of [X] but not others (especially multi-word or punctuation-heavy session names). v2 should phase the work:

- Phase 1: Manual dial via Android dialer / Auto contact picker → session answers. Rock-solid.
- Phase 2: Harden the "Hey Google, call my agent" path with chosen contact labels / aliases.

### 4. Android app UI scope beyond the call

Minimum viable Android app beyond the call backbone:

- Initial setup: point at a pimote server (URL + auth).
- Live sync indicator ("connected to pimote").
- Settings for which sessions to register as contacts (bounded LRU? all? user-pinned only?).
- Optional: a list view of sessions with state, mirroring the PWA's ActiveSessionBar — useful when you land on the phone at a desk rather than in a car.

**Not** in scope for Android in v2 (still PWA-only): the full chat/scrollback rendering. The phone is a call client; when you want to read, you use the PWA.

### 5. Multi-user / multi-device

Speechmux's brainstorm locked **"single user, single device for MVP"** to keep auth / identity simple. Pimote has a different baseline — `clientId`-based identity already lives in the WS protocol; push subscriptions are per-device. v2 Android can probably support multi-device-same-user from day 1 (same account installed on phone + car head unit + PWA), though that needs explicit thought about which devices receive which agent-initiated calls.

Multi-user is farther out. For v2 assume one user.

## Ideas pulled from `speechmux/docs/brainstorms/android-auto-agent-calling.md`

The speechmux brainstorm is a **speechmux-native** product proposal — a distinct product that could exist if speechmux had its own calling app without pimote. Its architectural choices differ from pimote's substantially (LiveKit bridge, call-control-inside-speechmux, loose security). But several of its decisions and open questions are directly useful here:

- ✅ **Telecom-native dialer-style outgoing** — pimote already aligned.
- ✅ **Bi-directional calling as the end goal** — adopted for v2 (agent-initiated calls via FCM above).
- ✅ **Phase voice invocation: Telecom first, Assistant polish later** — adopted for v2 (reliability section above).
- ✅ **Per-session (in speechmux's case: "per-Agent") persistent identity** — informed the sessions-as-contacts tension above.
- ✅ **FCM-triggered incoming calls** — adopted for v2.
- ✅ **"No new backend service"** — pimote agrees in spirit but implements differently: call-control lives in pimote server, not inside speechmux. This is a deliberate divergence (DR-012): pimote is the orchestrator, speechmux is a focused voice sidecar.

Diverges from speechmux's brainstorm on:

- ❌ **LiveKit bridge.** Pimote uses WebRTC directly to speechmux (via Cloudflare Realtime TURN). No LiveKit dependency. Rationale: simpler stack, speechmux's WebRTC transport is already implemented and tested; LiveKit adds a service we don't need.
- ❌ **"Start without TURN."** Pimote uses Cloudflare Realtime TURN from day one (DR-012). Cellular networks and restrictive corporate Wi-Fi make direct peer-to-peer unreliable; TURN availability is a feature, not an optimization.
- ❌ **"Loose homelab security baseline."** Pimote ships with Cloudflare tunnel + auth (pimote's existing deployment story). Voice adds no security relaxation.
- ❌ **"Single callee identity (Agent)."** Pimote's v1 chose sessions-as-contacts; v2 revisits this but doesn't default to speechmux's single-Agent model.
- ❌ **"Single user, single device."** Pimote already has `clientId` / push-subscription infrastructure that makes multi-device trivial; v2 Android can support it from day one.

## Open questions (for architect phase when v2 starts)

- Session-identity-model choice (A/B/C from section 2 above).
- Incoming-call policy surface: per-session, per-project, per-time-of-day? Stored where (pimote server config? client preference? both)?
- Bounded-LRU sizing for `PhoneAccount` registrations if we keep sessions-as-contacts.
- Missed-call semantics — voicemail-style fallback via existing push infra, retry cadence, deduplication.
- Bluetooth audio routing gotchas with `SelfManagedConnectionService` — probably fine but worth a real test in a car before shipping.
- Interaction with a real PSTN call arriving during an agent call (and vice versa).
- Android Auto DHU testing story (voxcoder had scripts for this — worth reusing patterns).
- Packaging / distribution: direct APK, Play Store (with `SelfManagedConnectionService` review implications), or internal track?

## Dependencies on v1 work

- v1 protocol (`call_bind` / `call_end` / `call_ready` / `call_ended` / `call_status`) must be stable. The Android client consumes the same interfaces; changes v1-side should be considered breaking-for-Android.
- Speechmux-repo work (`pimote-harness-integration` brainstorm): per-call auth tokens + listener-lifecycle refactor. Both must land before Android v2 starts, same as they must land before v1 end-to-end smoke.
- Agent-initiated calls require pimote's push-notification path to grow a `call` variant on the `interaction` payload schema — trivial server-side.

## Provenance

- Voice-mode v1 brainstorm (source of the settled starting points): `docs/brainstorms/voice-mode.md`, deleted in cleanup commit `060a5c1`; last present in commit `9b63a12`.
- DR-011 through DR-014 (pimote `docs/decisions/`): interpreter-as-primary, speechmux sidecar + WebRTC, PWA-first v1, walk-back scope.
- Speechmux android brainstorm (source of bi-directional / phasing / FCM ideas): `/home/alenna/repos/speechmux/docs/brainstorms/android-auto-agent-calling.md`. Speechmux-native product proposal — read for ideas, not as the pimote architecture.
