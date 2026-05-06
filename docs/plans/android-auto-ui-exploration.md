# Android Auto UI for Pimote — Mute + Live Status

Investigation only. Goal: surface (1) a mic mute toggle and (2) live "what is the assistant doing" status on the Android Auto head unit while a pimote voice call is bound.

## TL;DR

The pimote Android app is already a self-managed `ConnectionService` calling app (`MANAGE_OWN_CALLS`). When a call is bound, **Android Auto renders its own system in-call UI** — and that UI already includes a mute button, end-call button, and audio routing. So the "mute toggle" affordance on Auto fundamentally already exists; what's missing is wiring `Telecom.CallAudioState.isMuted` through to the WebRTC mic. Live status is harder — Auto does not let third-party calling apps draw custom in-call UI. The only honest channel for status is `Connection.setStatusHints(...)` (label + icon), and we have to plumb a panel-derived status string into it from the WS event stream. Building a separate CarAppService/MediaBrowserService for a status screen is possible but ranges from "policy-risky" to "abuse of category"; not recommended as the primary path.

## Current Architecture (relevant slices)

### Call stack — pimote Android (`mobile/android/`)

- `mobile/android/app/src/main/AndroidManifest.xml:6-9` — declares `MANAGE_OWN_CALLS`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`. **No** `CarAppService`, no `MediaBrowserService`, no Auto metadata.
- `telephony/PimoteConnectionService.kt` — self-managed `ConnectionService`; outgoing-only.
- `telephony/PimoteConnection.kt:31-34` — `onCallAudioStateChanged(CallAudioState)` is wired and converts the framework state into `AudioRouteSnapshot(isMuted, route, supportedRoutes)`.
- `call/CallController.kt:267-269` — `onAudioStateChanged` only stores the snapshot in `_audioRoute`. **It does not propagate `isMuted` to `peer.setMicMuted(...)` and does not update `_isMicMuted`.** That is the root cause of "mute from the system/Auto UI doesn't actually mute the mic."
- `call/CallController.kt:119-136, 195-196, 275-277` — app-driven mute path (`setMicMuted`) lives separately, called only from the in-app `InCallScreen` (`ui/call/InCallScreen.kt:87, 232`). On Auto the in-app screen is not the visible UI.
- `voice/SpeechmuxPeerImpl.kt:639-641` — `setMicMuted(muted)` toggles `audioTrack?.setEnabled(!muted)`; cheap, idempotent, exactly what we'd call from a Telecom callback.

### Voice / streaming pipeline (server side)

- `server/src/voice-orchestrator.ts` — owns the call binding; emits `voice:activate`/`voice:deactivate` into the per-session `EventBus`.
- `server/src/session-manager.ts:174-217` — every session subscribes to the `pimote:panels` EventBus channel, applies messages to a per-session `Map<namespace, Card[]>`, and emits a throttled `panel_update` WS event (~200ms) to clients.
- `server/src/panel-state.ts` — pure helpers (`applyPanelMessage`, `getMergedPanelCards`).
- `shared/src/protocol.ts:773-779` — wire shape: `PanelUpdateEvent { sessionId, cards: Card[] }`.
- `packages/panels/src/types.ts` — `Card { id, color?, header{title,tag?}, body?, footer? }`. This is the structured "what's happening" surface we'd lean on.
- `packages/voice/src/...` — voice extension is a panels _consumer of the EventBus event_ indirectly; it doesn't currently _publish_ panel cards itself, but the worker subagent's panels output flows through the same channel.

### What the Android client currently consumes

- `mobile/android/.../protocol/Protocol.kt:33-274` — Kotlin DTOs cover folders/sessions, `open_session`, `call_bind`/`call_end`, and `call_*` events. **Nothing for `panel_update`, `message_update`, `agent_start`/`agent_end`, or any streaming state.** A grep confirms zero references to `panel`, `message_update`, etc., in `mobile/android/app/src/main/kotlin`.

So the Android app today is voice-blind to the assistant's working state. The PWA derives its `listening / thinking / speaking` pulse client-side from the streaming events (codemap: `client/src/lib/components/call-state.ts` `deriveAgentState`). No equivalent exists on Android.

## What Android Auto actually allows

Honest version: Auto is one of the most locked-down third-party UI surfaces on Android. Only specific app categories are accepted, and only via specific frameworks. Relevant ones for us:

| Framework                                                 | Category                                              | Custom UI?                                | Fits us?                                                 |
| --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| Self-managed `ConnectionService` (`MANAGE_OWN_CALLS`)     | Calling                                               | **No** — system renders the in-call UI    | **Yes — already what we are**                            |
| `MediaBrowserService` + media session                     | Media playback                                        | Templated only (browse + now-playing)     | Misuse; not a media app                                  |
| `CarAppService` + Car App Library templates               | Navigation, POI, Charging, IoT, Driving Task, Weather | Templated only (Pane/List/Grid/Place/Map) | None of the categories cover "voice assistant companion" |
| `CarAppService` + Messaging template (`ConversationItem`) | Messaging (TTS read-aloud + reply)                    | Templated, very narrow                    | We're not SMS/RCS-shaped                                 |
| `NotificationCompat.CarExtender` + `MessagingStyle`       | Messaging notifications                               | Templated, read-aloud only                | Same as above                                            |

Important constraints:

- For self-managed calls, Auto **bypasses** any custom `InCallActivity` and renders its own ongoing-call surface. We do not get to draw pixels there.
- The in-call UI does surface: the contact display name, mute/end/route buttons, and (per `Connection` API docs) the `StatusHints` label + small icon. StatusHints rendering on Auto specifically is not contractually guaranteed by Google docs but works in practice on current Automotive/AAOS in-call surfaces — needs a real-device check.
- Distribution: an Auto app that ships in Play Store has to declare a category in its manifest and pass Google's "Driver Distraction" review. Calling apps using `MANAGE_OWN_CALLS` don't need a category — they just work. Anything else (CarApp, MediaBrowser used as "status display") would.

## Best-fit Auto template for pimote

For a voice-first companion that's already a calling app, the natural surface is **the existing self-managed `ConnectionService` call**. That's the only Auto surface we get for free, the only one that fits the user's actual mental model ("I'm on a call with the assistant"), and it already provides the mute control. We just need to honor it and feed it status text.

## Data flow proposal — wiring panels into Auto status

```
worker subagent / extension
  -> EventBus channel "pimote:panels"
     -> server: applyPanelMessage -> per-session panelState Map
        -> throttled (~200ms) panel_update WS event { sessionId, cards }
           -> Android WsClient
              -> SessionRepository (or new PanelRepository)
                 -> CallController (filter to bound sessionId)
                    -> derive a single short string + icon
                       -> PimoteConnection.setStatusHints(StatusHints(label, icon, extras))
                          -> Telecom -> Auto in-call UI subtitle
```

Two new pieces on Android:

1. Protocol DTO for `panel_update` (and likely a small number of streaming events if we want a `listening / thinking / speaking` pulse independent of panels).
2. A pure "status reducer" — `(cards: List<Card>, agentState: AgentState?) -> StatusHints` — that picks one line of text. Most natural rule: take the most recent non-muted card whose `header.tag` looks status-shaped, fall back to `header.title`, fall back to a derived agent-state label. Bounded length (Auto truncates aggressively, ~30–40 chars safe).

## Mute — what actually has to change

The user perceives "mute from the car works" as one feature. It's two things:

**(a) Honor system/Auto-initiated mute.** The car's mute button calls into Telecom, which calls `Connection.onCallAudioStateChanged(state)`. Today that lands at `CallController.onAudioStateChanged` (`call/CallController.kt:267`) and is dropped on the floor for muting purposes. Forwarding `audioState.isMuted` into `peer.setMicMuted(...)` and `_isMicMuted` closes that loop. ~5 lines. No new UI.

**(b) Push-to-mute vs toggle.** Recommendation: stick with **toggle**. Auto's hardware affordance is a tap-to-toggle button on the in-call UI; push-to-mute would require a custom UI surface, which Auto won't render anyway. Toggle is also what the in-app `InCallScreen` already does (`ui/call/InCallScreen.kt:226-242`). Behavior is consistent across phone, car, and PWA.

A wrinkle: the user wants to "speak in the car without the assistant reacting." Plain mic mute solves this for the user-to-assistant direction. It does **not** stop assistant TTS already in flight from playing through the car speakers. If they want full bi-directional pause, that's a different feature ("hold the call" / barge-in suppression) — flag, not solve, here.

## Proposal Options

### Option A — "Just Telecom + StatusHints" (recommended)

Use the call we already have. No new Auto surfaces.

- Wire `onCallAudioStateChanged.isMuted` → `peer.setMicMuted` + `_isMicMuted` so the system mute button (and the Auto mute button) actually mutes the WebRTC mic.
- Add `panel_update` (and a minimal subset of streaming events if we want an agent-state pulse) to `Protocol.kt`.
- Add a per-call status reducer; route its output into `PimoteConnection.setStatusHints(StatusHints(label, smallIcon, extras))` whenever the call is `Active`.
- Throttle status updates conservatively (≥1s) — Auto rate-limits notification changes and rapid label flapping is distracting and potentially policy-flagged.

Tradeoffs:

- ✅ Zero policy risk, no new Play categories, fits existing architecture.
- ✅ Cheap: the data is already at the WS boundary; we just need DTOs + a reducer.
- ✅ Mute "just works" with the car's hardware/HMI button.
- ⚠️ Status surface is **one short string + small icon**. Cannot show panels as cards. Sufficient for "thinking…", "running tests…", "edit pkg.json", but not a list.
- ⚠️ StatusHints rendering on Auto is empirically reliable but not contractually documented for every OEM head unit. Needs a real-car smoke test.

### Option B — Option A plus a `MediaBrowserService` "status player"

Register a no-audio media session whose "now playing" track title/subtitle is the assistant status. Auto's media surface then becomes a secondary status window the user can tab to.

Tradeoffs:

- ✅ Gives a slightly larger surface (title + subtitle + small artwork + transport-control-shaped buttons).
- ❌ Misuses the media category; risks Play Store rejection if we ever publish.
- ❌ Second source of truth for "is pimote in-call" — duplication of state machines.
- ❌ Confusing UX: the media tab claims to play something while the call tab shows the same thing.
- ❌ Transport control buttons (play/pause/skip) don't map to anything coherent for an assistant.

Verdict: not recommended unless the user explicitly wants a bigger Auto status surface and accepts the policy risk.

### Option C — `CarAppService` templated companion app

Build a separate Auto entry point under one of the available categories. Closest fit on paper is **Driving Task** (recently broadened) or **IoT**. Render a `Pane` template with the current status card + a mute toggle row.

Tradeoffs:

- ✅ Real second screen with structured rows; closest to a true "panels view" on the head unit.
- ✅ Mute toggle becomes an explicit affordance independent of the call notification.
- ❌ Category fit is a stretch — Google reviewers have rejected non-task apps for Driving Task. Real distribution risk.
- ❌ Significant new code: Car App Library, lifecycle, separate manifest entry, screen graph, dual-state machine with `CallController`.
- ❌ Doesn't replace Auto's call UI — we'd have two Auto surfaces (call + companion) for the same conversation, which is the kind of split-brain UX Auto's review explicitly dings.

Verdict: not worth it for the marginal status real estate. Worth revisiting only if pimote ever wants a non-call presence on Auto (e.g., browse sessions while parked).

## Open questions / things to verify on a real head unit

1. Does `Connection.setStatusHints(...)` actually surface as visible text on Android Auto's in-call screen on current AAOS / projected Auto? Documented for AAOS; ambiguous on projected Auto. Needs a phone-in-Auto test before committing.
2. When the user mutes via the car's hardware button vs the car's on-screen button, does the framework deliver the same `CallAudioState` callback? (Expected yes; verify.)
3. Does Auto's call UI display the `Connection.callerDisplayName` or the `PhoneAccount` label? If the former, we have a fallback channel for status text by smashing it into the display name (ugly, but works).
4. Does throttling status updates to ≥1s avoid Auto's "noisy notification" policy heuristics?

## Recommended path

Option A only. Two scoped pieces of work:

1. **Mute correctness fix** — propagate `CallAudioState.isMuted` through `CallController` to the WebRTC peer. Tiny, no design needed, unlocks "Auto's mute button just works." Could land independently of any Auto-specific work.
2. **Live status via StatusHints** — add `panel_update` + minimal streaming events to `Protocol.kt`, build a `cards + agentState -> StatusHints` reducer, push into the live `PimoteConnection`. Verify on a real head unit before declaring done.

Defer Options B and C unless the user explicitly wants more Auto surface than a single status line.
