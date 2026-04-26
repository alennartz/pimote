# Brainstorm: Full-screen calling mode UI

## The idea

Replace the current thin `CallBanner` (and the in-page chat surface that sits behind it) with a full-screen "calling mode" while a voice call is active. Designed for **mixed posture in a single call**: phone-in-hand at one extreme, eyes-completely-off-the-screen-while-driving at the other. The same UI must work at both poles — no mode switch, no separate driving view.

The visual surface is glanceable when the user looks at it; audio carries any state the user _needs_ to know when they don't.

## Context

Voice mode v1 (PWA-first, see `docs/brainstorms/voice-mode-android.md` and DR-011..DR-014) ships a working interpreter + worker split with a minimal UI:

- `CallButton` in the status bar starts a call.
- `CallBanner` is a thin emerald strip above the chat with phase label, mute, and hang-up.
- `VoiceCallStore` exposes `idle | binding | connecting | connected | ending`, plus `micMuted` and `lastError`.

This shipped narrow on purpose. Now that the underlying call infrastructure is stable, the UI for being on a call deserves to be a first-class surface rather than a strip on top of the regular chat. The call is _the_ interaction while it's happening; it shouldn't share the screen with controls (model picker, status, panels) that aren't relevant during the call.

Target platform for v1 of this UI: **Android** (Chrome PWA). iOS quirks and the full Android-app calling story (`docs/brainstorms/voice-mode-android.md`) are out of scope.

## Key decisions

### Layout: full-screen, three regions

Calling mode replaces the current view (route push, not modal overlay). Three vertical regions, sized for phone aspect ratio:

- **Top** — session + project label, call duration, mic-state icon. Below it, a single-row state pulse with one word (listening / thinking / speaking).
- **Middle (most of the screen)** — the existing chat components reused as-is: `Message`, `EditDiffBlock`, collapsed tool-call rendering. Same rendering pipeline as the normal chat. Most-recent at bottom, scrolling, **touch-disabled**. Tool calls and other non-text blocks stay collapsed exactly as they are in the normal chat — no calling-mode-specific compaction.
- **Bottom** — gesture zone, large enough for big swipes, with permanently-visible hint labels.

_Why touch-disabled middle:_ calling mode is meant to survive phone-in-pocket, palm presses, and inadvertent contact while driving. Confining all interaction to a known bottom zone makes the rest of the screen safe to ignore.

_Why reuse chat components instead of a calling-specific transcript:_ the worker subagent activity (tool calls, file edits) is exactly what the user wants to glance at — "is the agent actually doing something?" — and that's already rendered well in the normal chat. A parallel rendering pipeline would diverge over time and double the maintenance.

### Three states for the agent pulse

The state row shows one of three states with distinct color/animation, readable at a glance:

- **Listening** — soft cyan, slow breathe.
- **Thinking** — amber, faster pulse. Covers the "you spoke, agent is grinding silently" case, which is the main eyes-on glance trigger ("is it actually doing something or did it crash?").
- **Speaking** — green, in-sync with TTS amplitude.

No tones for state changes — the agent's voice is its own audio cue for "speaking," and the absence of voice covers "thinking" and "listening" once the user has the mute/abort cues internalized.

### Three gestures, that's it

The bottom zone is a single gesture surface, not a row of buttons. iPhone-style "slide to end call" feel.

- **Swipe up = hang up.** Big motion, hard to do by accident.
- **Tap = mute toggle.** Persistent (not push-to-talk hold) — single-handed and easy to do without looking. Toggle requires an unmissable cue (see audio cues below) to avoid the talking-into-a-muted-phone failure mode.
- **Swipe down = abort.** Stops the agent's current work without ending the call. Distinct from hang-up.

_Why these three and not more:_ eyes-free use means gestures must be memorizable. Three is a comfortable ceiling; five would conflict and require thinking. Anything voice-triggerable ("what?", "wait, hold on") is left to voice, not duplicated as a gesture.

_Why abort and not walk-back:_ walk-back as a user-facing gesture is awkward to specify — a swipe undoes _what_, exactly? Last turn? Last N? You can't see what you're undoing without looking, which defeats eyes-free. Abort is the actually-needed capability: when worker subagents grind silently for minutes on the wrong thing, killing the run has to be one motion. Walk-back stays as a server-side mechanism (DR-014) triggered by interpreter-detected phrases, just not a UI gesture.

_Why no push-to-talk:_ current design is always-on / interpreter-driven. PTT is a different interaction model entirely (walkie-talkie vs phone call) and the user's framing is "phone UX." Out of scope for v1.

### Visual hints for gestures, always visible

Gesture hints are part of the bottom zone, not a separate label area, and are permanently visible (not tap-to-reveal). Up-chevron above "Hang up" previews the upward swipe; "Tap to mute" sits in the middle as the touch target; down-chevron below "Abort" previews the downward swipe.

_Why permanently visible:_ eyes-free use means the hints have to be there _before_ the user looks, not appear when they touch. Hidden affordances defeat the purpose.

### Audio cues, scoped to driving-critical state

Audio cues are the eyes-free counterparts of visual indicators — but only for state the user _needs_ to know when they can't see the screen.

- **Mute toggle** — distinct tones for on vs off, every toggle. Non-negotiable: without this, tap-to-toggle is dangerous.
- **Abort** — confirm tone (or short voice "aborted") so the swipe is acknowledged audibly.
- **Hang up** — natural; the call audio drops.
- **Agent state (listening / thinking / speaking)** — visual only, no tones. Speaking is already audible; thinking is the absence of speech. Tones here would be noise pollution.
- **Connection issues** — see lifecycle below.

### Lifecycle

- **Entry** — tap the call entry point → calling mode replaces the current view (route, not overlay).
- **Exit on hang-up** — returns to the normal view of _the same session_ (not the session the user was viewing pre-call, since they could be different).
- **Auto-lock mid-call** — audio continues; waking the phone returns to calling mode. Confirmed Android-only for v1.
- **PWA backgrounded by another app** — leave as is. Android Chrome's current behavior is the spec; we don't design around it for v1.
- **Network failure / call lost** — the call ends like any other `call_ended`-with-error. Calling mode auto-returns to the normal view of the same session as soon as the call ends; the error (if any) surfaces as a transient toast / banner in normal view, not as a gesture-to-dismiss screen. No need to make the user dismiss a dead-call surface. **No "reconnecting…" state**, because the underlying client has no reconnection logic — `VoiceCallStore` traces ICE state changes but doesn't act on them. Speccing a reconnecting UI would be designing for a state the system can't produce. If reconnection logic ever lands, the UI for it is a separate concern.

### Mobile call entry point lives in the overflow menu

On mobile, the `CallButton` moves out of the inline status bar and joins `ModelPicker` / `ThinkingPicker` in a single overflow / options menu. The status bar is already crowded on mobile; one tappable session menu is cleaner than three icons fighting for space.

Desktop layout is unaffected by this brainstorm — the inline button can stay (or also move; either works). Decision is mobile-specific.

## Direction

Build a route-level full-screen calling mode for Android Chrome PWA users:

1. New route / page-level view that owns the screen while a call is bound.
2. Top region: session label + duration + mic icon + state pulse (3 states).
3. Middle region: existing chat components, touch-disabled, scrolling.
4. Bottom region: gesture zone with three gestures (swipe up / tap / swipe down) and permanently-visible hint labels.
5. Audio cues for mute toggle and abort. No tones for connection or agent state.
6. On mobile, move the call entry point into the same overflow menu as the model and thinking pickers.
7. Lifecycle is "v1 honest": no reconnection UI, no PWA-background special-casing, no iOS work. Network drop = call ends, calling mode auto-returns to normal view, error surfaces as a toast there.

## Open questions (for architect)

- Gesture zone dimensions and swipe thresholds — how tall does the bottom zone need to be for an unambiguous big swipe without eating the transcript area?
- Hit-testing rules for the touch-disabled middle — does scroll work? (Probably not, for safety.) Does long-press do anything? (Probably not, ditto.)
- Whether `CallBanner` survives at all once calling mode exists, or is fully replaced.
- Where the mobile overflow menu lives structurally — is there an existing surface to join, or does this brainstorm imply creating one?
- Audio cue specifics — pre-recorded tones vs synthesised, volume relative to TTS, ducking behaviour while the agent is mid-speak.
- Accessibility: screen reader behaviour over a touch-disabled middle, large-text scaling for the gesture hints, color-blind alternatives to the state pulse colors.
- Theming — calling mode inherits app theme or has its own (e.g. always-dark for night driving)?

## Provenance

- Voice-mode v1 brainstorm (deleted in cleanup commit `060a5c1`; last present in commit `9b63a12`).
- DR-011..DR-014 — interpreter-as-primary, speechmux sidecar + WebRTC, PWA-first v1, walk-back scope.
- `docs/brainstorms/voice-mode-android.md` — Android v2 follow-up; this brainstorm is the PWA-side UI improvement that lands before any of the Android-app work.
- Current code: `client/src/lib/components/CallButton.svelte`, `client/src/lib/components/CallBanner.svelte`, `client/src/lib/components/StatusBar.svelte`, `client/src/lib/stores/voice-call.svelte.ts`.
