# Brainstorm: Native Android client (v1)

## The idea

A native Android client that complements — not replaces — the PWA. The PWA is unfit for the two use cases this client targets:

1. **Sustained voice calls** — PWAs lose the mic when the screen locks or the user switches apps. A native app can keep a call alive through screen lock and backgrounding via Android's telephony stack.
2. **Android Auto** — PWAs cannot integrate with car head units. Android Auto is the _primary_ driver for going native.

The client is **voice-first**. Full chat/scrollback rendering is explicitly out of scope; that stays in the PWA.

This brainstorm supersedes the prior `voice-mode-android.md` for what we are actually building in v1. That document anticipated agent-initiated calls, FCM, ContactsProvider sync, and bounded-LRU session registration — all deferred. We are doing the simplest thing that demonstrates the use case end-to-end.

## Settled starting points (carried from voice-mode v1)

These come from voice-mode v1 (DR-011 through DR-014) and are not relitigated here. Cross-checked against the implemented protocol in `shared/src/protocol.ts` and `server/src/voice-orchestrator.ts`:

- **Same wire protocol as the PWA.** `call_bind` / `call_bind_response` / `call_ready` / `call_ended` / `call_status` are already implemented and in use. The native client consumes the exact same interfaces. No protocol changes for v1.
- **No per-call tokens.** v1 brainstorm anticipated minting them; the actual implementation does not. Cloudflare Access on `/signal` is the auth boundary; TURN credentials come back in speechmux's `/signal` `session` response directly to the client. The native client follows the same flow.
- **No server changes.** Pimote server is untouched. Speechmux is untouched.
- **WebRTC peer to speechmux directly.** Two connections: WS to pimote (control/signaling/session discovery), WebRTC to speechmux's `/signal`.
- **Single-owner displacement model.** Native dialing displaces existing owner with `call_ended { reason: 'displaced' }`. Same as PWA.
- **Interpreter-as-primary + `my-pi` worker subagent topology.** Unchanged. The native app is a peer to the PWA — a different entry point into the same session.

## Decisions

### Platforms

**Android only for v1.** iOS and CarPlay are out of scope.

_Why:_ The driving use case is Android Auto. iOS would more than double the work. There is no cross-platform stack that meaningfully shares the telephony layer — `SelfManagedConnectionService` (Android) and CallKit + CarPlay (iOS) have no common abstraction in Flutter, React Native, KMP, or MAUI. All those frameworks require hand-rolled native plugins per platform for telephony, with shared code limited to the WS/state-machine layer. KMP would be the most legitimate sharing strategy _if_ iOS happens later — lift the protocol layer into shared Kotlin at that point. Not now.

### Tech stack

- **Native Kotlin + Jetpack Compose** for UI.
- **`io.getstream:stream-webrtc-android`** for WebRTC (modern, maintained fork of Google's libwebrtc bindings).
- **OkHttp WebSocket** for the pimote control connection.
- **`androidx.browser.customtabs.CustomTabsIntent`** for the Cloudflare Access OIDC redirect flow.
- **`SelfManagedConnectionService`** for telephony.

_Why:_ Every example, every SO answer, every Google sample for `SelfManagedConnectionService` is Kotlin. Wrapping it through a cross-platform framework means hand-rolling a plugin and debugging across two languages when telephony does something weird — which it will. With iOS off the table, abstraction tax buys nothing.

### Repo layout

`mobile/android/` inside the existing monorepo, as its own top-level folder with its own Gradle project. Independent build; cross-references the protocol via shared file path conventions. Single PR can update protocol + client together.

_Why:_ Protocol is the glue. Keeping the Android client adjacent to `shared/src/protocol.ts` reduces drift risk. Sibling repo would buy CI/release independence at the cost of synchronization friction; not worth it for a single-platform client.

### Protocol type sharing

**Hand-write Kotlin data classes** matching the subset of `shared/src/protocol.ts` the client uses. No codegen.

_Why:_ The surface is small (`call_bind`, `call_bind_response`, `call_ready`, `call_ended`, `call_status`, plus session-list and basic meta). Codegen plumbing costs more than it saves at this scale. Drift risk is real but manageable; if it becomes a problem later, add a round-trip fixture test against a running server.

### Auth — Cloudflare Access OIDC

The server side already does OIDC via Cloudflare Access. The native client needs to **handle the redirect**: when the WS upgrade or `/signal` request returns a Cloudflare Access redirect, open a `CustomTabsIntent`, let the user authenticate in the system browser, capture the resulting `CF_Authorization` JWT, persist it, and attach it to subsequent WS and `/signal` requests as cookie or `cf-access-token` header.

No server changes. No protocol changes. Refresh handled by re-running the redirect flow on 401/302.

### Telephony — sessions and projects as contacts

Each entity registers as a `PhoneAccount` via `SelfManagedConnectionService`:

- **Each unarchived session** → `PhoneAccount` with display name `<folder>/<session-name>`.
- **Each project (folder)** → `PhoneAccount` with display name `<folder>`. Calling it creates a new session in that project and binds the call to it.
- **Archived sessions** → deregistered.

_Why prefix with folder:_ Disambiguates session names across projects in the system contacts list and dialer, and makes voice intents unambiguous: "Hey Google, call pimote/cleanup-refactor" targets the right session; "Hey Google, call pimote/my-app" creates a new session in `my-app`.

### Outgoing only

No agent-initiated (incoming) calls in v1. No FCM. No `interaction:call` push variant. No retry / missed-call / voicemail semantics.

_Why:_ All of that is real work and the user explicitly said simplest first. Outgoing dial via system contacts and voice intent demonstrates the core hypothesis (Android Auto + sustained voice work end-to-end). Incoming is a v2 topic.

### Session list sync

The app holds a persistent WS connection **only while running**. On WS connect, the app fetches the session list and registers/deregisters `PhoneAccount`s to match. When the app process is killed, registrations may go stale until next launch. Acceptable for v1.

_Why not a foreground service:_ That keeps WS alive in background but adds battery cost, persistent notification, and `FOREGROUND_SERVICE` permissions. Defer until we know the staleness UX is actually painful.

_Why not FCM:_ See "Outgoing only."

### UI scope

The native app has three screens:

1. **Setup / settings** — point at a pimote server URL, kick off the OIDC redirect flow, show connection status.
2. **Contacts (phone mode)** — visual list of session and project `PhoneAccount`s, tappable to dial. This is the phone-mode session picker; the system contacts/dialer is the Auto-mode picker.
3. **In-call screen** — Android-native. Conceptually mirrors the PWA's `CallingMode` + `CallGestureZone` + `CallHeader` (mute, hangup, gesture-driven controls), but rendered in Compose with native styling. Not a port of the Svelte components.

**Not in scope:** chat/scrollback rendering, slash commands, panels, dialogs, push notifications, fork/tree-navigate, model switching, compaction. The PWA owns all of that.

### Android Auto

**No custom Android Auto UI in v1.** No `CarAppService`, no Android for Cars App Library work.

_Why:_ The whole pitch of `SelfManagedConnectionService` is "be a phone call." When registered, our `PhoneAccount`s appear automatically in:

- Auto's native contact picker
- Auto's in-call screen (rendered by the system from our ConnectionService metadata)
- Recents / call history
- Google Assistant voice intents ("Hey Google, call pimote/my-app")

Hardware controls (answer/hangup/mute on the wheel or head unit) work by virtue of being a real telecom call. Custom in-call actions (e.g., "interrupt", "abort") can be exposed as call-control actions that Auto will surface.

`CarAppService` is a separate review track and effectively a second app. Not justified until we've used the dumb-phone-call flow in a real car and found something it can't do.

### Voice-invocation phasing

- **Phase 1 (v1 ships this):** manual dial via the contacts list / Auto contact picker / system dialer. Rock-solid.
- **Phase 2 (later):** harden "Hey Google, call my agent" — investigate which display-name conventions Assistant matches reliably, add aliases if needed.

### Distribution

Sideload / developer-mode install only for v1. No Play Store, no internal Play track. `SelfManagedConnectionService` has Play review implications; revisit when v1 is proven.

## Open questions (for architect phase)

- **Foreground service trade-off.** "Sessions go stale when the app is killed" sounds OK on paper. Need to validate during architect/implement: does Android route a "Hey Google, call pimote/X" intent to the registered `PhoneAccount` when the app process is dead? If not, we may need a foreground service after all.
- **CF_Authorization on the WebRTC `/signal` request.** PWA piggybacks on the browser cookie. Native client likely sends the JWT as a header (`cf-access-token`) or as a cookie on the WS upgrade. Confirm speechmux's `/signal` accepts the header form.
- **Display name sanitization.** What if a folder or session name contains `/`, control characters, very long strings, or unicode that breaks `PhoneAccount` registration or Assistant matching?
- **WebRTC ICE/TURN flow.** PWA gets TURN creds in speechmux's `/signal` `session` response. Confirm the native WebRTC stack consumes the same payload shape; document any differences.
- **In-call gesture vocabulary.** Which PWA gestures translate to a thumb-reachable phone-mode UI? Which expose as Auto call-control actions? Worth a quick audit during architect.
- **`PhoneAccount` registration churn.** Forks, renames, archives generate registration changes. Make sure we don't thrash the OS's call-history/contact UIs on every WS event.
- **Multiple pimote servers.** Setup screen currently scoped to one. If we want to support multiple, namespace `PhoneAccount`s by server. Probably a v2 concern but flag now.

## Dependencies

- v1 wire protocol stable. Any change to `call_bind` / `call_ready` / `call_ended` / `call_status` is a breaking change for the native client.
- Voice mode v1 must be working end-to-end against speechmux. The native client adds nothing speechmux-side.

## Provenance

- Prior brainstorm (planned v2 with FCM + agent-initiated calls + sessions-as-contacts options A/B/C): `docs/brainstorms/voice-mode-android.md`. Retained for historical context; superseded by this document for what v1 actually builds.
- Voice-mode v1 decisions: DR-011 (interpreter-as-primary), DR-012 (speechmux sidecar + WebRTC), DR-013 (PWA-first; Android deferred), DR-014 (walk-back scope).
- Implemented protocol surface: `shared/src/protocol.ts` (CallBind/CallEnd commands, CallBindResponse/CallReady/CallEnded/CallStatus events). `server/src/voice-orchestrator.ts` for the bind flow.
- PWA voice-mode reference implementation: `client/src/lib/stores/voice-call.svelte.ts`, `client/src/lib/stores/voice-call-seams.ts`, components under `client/src/lib/components/Call*.svelte`.
