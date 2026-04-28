# DR-015: Full-screen calling mode with touch-disabled transcript and bottom-zone gesture island

## Status

Accepted

## Context

Voice mode v1 (DR-011..DR-014) shipped a working interpreter+worker call with a deliberately narrow UI: a thin `CallBanner` strip above the regular chat with phase label, mute, and hang-up. With the call infrastructure stable, the in-call surface needed to be a first-class screen — and specifically one that survives **mixed posture in a single call**: phone-in-hand at one extreme, eyes-completely-off-the-screen-while-driving at the other. The same UI must work at both poles, no mode switch.

Target platform was Android Chrome PWA. iOS quirks and the native-Android-app calling story were out of scope.

Several rejected alternatives shaped the chosen design:

- **Keep `CallBanner` as a fallback alongside the new surface.** Rejected — having two in-call UIs doubles the maintenance and creates ambiguity about which is canonical.
- **Build a parallel transcript pipeline tuned for in-call.** Rejected — worker subagent activity (tool calls, edits) is exactly what the user wants to glance at, and the existing `Message` / `ToolCall` / edit-diff rendering already does that well; a parallel pipeline would diverge over time.
- **Make the transcript area touch-active (scroll, long-press).** Rejected — eyes-free use means the screen has to be safe to ignore. Palm contact, in-pocket touches, and inadvertent contact while driving must not do anything.
- **Push-to-talk gesture, walk-back-as-gesture, additional gestures (e.g. side swipes).** Rejected — eyes-free use caps the memorable gesture count at three. PTT is a different interaction model (walkie-talkie vs phone). Walk-back as a UI gesture can't be specified without looking at the screen ("undo what, exactly?"); walk-back stays as a server-side mechanism (DR-014) triggered by interpreter-detected phrases.
- **Tap-to-reveal gesture hints.** Rejected — hidden affordances defeat eyes-free use; hints must be present before the user looks.
- **Audio tones for agent state and connection events.** Rejected — speaking is already audible, thinking is the absence of speech, and the client has no reconnection logic to soundtrack. Tones here would be noise pollution. Audio cues are scoped to state the user _needs_ to know when eyes are off the screen.
- **A "reconnecting…" UI.** Rejected — `VoiceCallStore` traces ICE state but doesn't act on it. Speccing a reconnecting UI would be designing for a state the system can't produce.

## Decision

The in-call UI is a full-screen "calling mode" surface that fully replaces `CallBanner` (deleted). The contract is the union of these choices, kept together because they reinforce each other:

- **Three regions, top-down:** session/duration/mic header with an agent-state pulse (listening / thinking / speaking); a `MessageList readOnly` middle that reuses existing chat rendering with `pointer-events: none`; a bottom gesture zone (`min(25vh, 200px)`, 120px floor) with permanently-visible hint labels.
- **Exactly three gestures, all originating in the bottom zone:** tap = mute toggle, swipe-up (`Δy ≤ -80px`) = hang up, swipe-down (`Δy ≥ +80px`) = abort. Pointer capture lets swipes that start in the zone but end outside still register. Multi-touch cancels.
- **Audio cues scoped to driving-critical state:** distinct mute-on / mute-off beeps on every toggle (non-negotiable — without this, tap-to-toggle is dangerous), a double-beep abort confirm, and no cue on hang-up (the call audio drop is its own cue). No tones for agent state or connection events.
- **Abort uses the existing `AbortCommand` wire shape**, not the persisted-entry `VOICE_INTERRUPT_CUSTOM_TYPE` tag (which is a scrollback marker, not a client→server command type). Abort leaves the call connected; only hang-up ends it.
- **Mobile entry point** moves into a new "Voice call" row in `SessionSettingsDialog` (joining the model/thinking pickers in the existing options surface). Desktop `StatusBar` keeps its inline `CallButton`.
- **v1 lifecycle is "honest":** no reconnection UI, no PWA-backgrounding special case, no iOS work. A network drop ends the call like any other `call_ended`-with-error; calling mode unmounts via the conditional in `+page.svelte`, and any error surfaces as a transient toast in normal view.

## Consequences

- The three-gesture cap constrains future in-call interactions to voice (which is the intended escape valve) or a UI overhaul. Adding a fourth gesture would erode memorability for the existing three.
- Reusing `MessageList` means changes to chat rendering (tool-call collapse rules, edit-diff visuals, TTS button) propagate into calling mode automatically — usually desirable, but worth noticing when a chat-only feature wouldn't make sense in-call.
- `MessageList` now carries a `readOnly` prop whose only consumer is calling mode; future refactors should preserve it.
- Accessibility limitations are accepted in v1: the agent-state pulse leans entirely on color (no shape/icon redundancy), large-text scaling for gesture hints isn't tuned, and screen-reader semantics over the touch-disabled middle aren't designed. A follow-up should add at least color-blind redundancy to the pulse.
- Theming inherits the surrounding app theme — no always-dark / night-driving treatment. If real-world driving use shows the day theme is too bright, revisit.
- Audio cues do not duck the inbound WebRTC stream; ~80ms beeps may occasionally clip a TTS syllable. If this is audibly disruptive in practice, add a `GainNode` on the inbound path to duck during cues.
- The "no reconnection UI" choice is contingent on `VoiceCallStore` having no reconnection logic. If reconnection ever lands, the calling-mode surface needs a state for it; this DR's reasoning would no longer apply.
- `CallBanner.svelte` is deleted; there is no fallback in-call UI. Any environment where calling mode can't render is an outage of the in-call surface.
