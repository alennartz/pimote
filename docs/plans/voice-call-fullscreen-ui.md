# Plan: Voice-call full-screen UI

## Context

Replace the thin `CallBanner` strip with a full-screen "calling mode" surface designed for mixed posture (phone-in-hand ↔ eyes-off-driving) on Android Chrome PWA. See `docs/brainstorms/voice-call-fullscreen-ui.md` for the design rationale, gesture set, audio-cue policy, and lifecycle decisions — those are settled context for this plan.

## Architecture

### Impacted Modules

- **Client** — primary impact. The chat surface in `+page.svelte` gains a conditional render: when the active voice call is bound to the viewed session, calling mode replaces the normal `MessageList` / `InputBar` / status surfaces. `CallBanner.svelte` is deleted (calling mode is its replacement, no fallback). `CallButton.svelte` keeps its start/stop logic and gets reused inside `SessionSettingsDialog`. The inline mobile phone button in `+layout.svelte`'s mobile header is removed; entry point on mobile is the existing settings dialog. Desktop `StatusBar.svelte` is unchanged. `VoiceCallStore` gains a `startedAt` timestamp for the duration display, and a deterministic source for the "agent state" pulse is derived in the calling-mode component (not added to the store).
- **Protocol** — no changes. All new behaviour is client-only.
- **Server** — no changes. The voice extension and orchestrator are not touched.

### New Modules

All new components live under `client/src/lib/components/`. They form a small, self-contained calling-mode subtree, owned by `+page.svelte`.

- **`CallingMode.svelte`** — top-level full-screen container rendered conditionally by `+page.svelte` when `voiceCallStore.state.phase !== 'idle'` and the call is bound to the viewed session. Owns the three-region layout (header / transcript / gesture zone). No app shell, no panels, no nav. Reads `VoiceCallStore` and `sessionRegistry.viewed`.
- **`CallHeader.svelte`** — top region. Renders session + project label, call duration (`MM:SS`, re-rendered every second from `startedAt`), mic-state icon, and hosts `CallStateRow.svelte` for the agent-state pulse. Read-only.
- **`CallStateRow.svelte`** — the pulse + state-word row. Takes a discrete `AgentState` and a continuous `remoteAudioLevel`. Renders one of three visual treatments (see Interfaces) chosen by the discrete state; the speaking treatment animates in sync with the level.
- **`CallGestureZone.svelte`** — bottom region. Renders the three permanently-visible hint labels (up-chevron + "Hang up", "Tap to mute", down-chevron + "Abort") and owns the pointer-event handling that translates gestures into store calls (`endCall` / `toggleMute` / abort command). Plays the audio cues for mute toggle and abort.
- **`CallAudioCues.ts`** — small WebAudio helper exposing `playMuteOn()`, `playMuteOff()`, `playAbortConfirm()`. Synthesised tones via `OscillatorNode` + a short gain envelope; lazy-initialised `AudioContext`; no asset files. Pure logic module, unit-testable behind a seam.

The middle region of `CallingMode.svelte` reuses the existing `MessageList.svelte` directly (with a `readOnly` / `disableInteraction` prop added to MessageList — see Interfaces) to inherit `Message` / `EditDiffBlock` / `ToolCall` rendering verbatim. No parallel transcript pipeline.

### Interfaces

#### `VoiceCallStore` extensions

`VoiceCallState` gains one field; the store gains no new methods. The duration tick lives in the component, not the store.

```ts
export interface VoiceCallState {
  phase: VoiceCallPhase; // unchanged
  sessionId: string | null; // unchanged
  micMuted: boolean; // unchanged
  lastError: string | null; // unchanged
  startedAt: number | null; // NEW: epoch ms; set when phase first becomes 'connected', cleared on idle
}
```

Behaviour:

- `startedAt` is set exactly once per call, on the first transition into `phase === 'connected'`. Subsequent re-entries (none today, but defensive) do not reset it.
- `startedAt` is cleared (back to `null`) whenever phase returns to `idle`.

The store also gains an **abort capability** invoked by the gesture zone. The exact wire mechanism is the existing `VOICE_INTERRUPT_CUSTOM_TYPE` already on the protocol (referenced by `server/src/voice/walk-back.ts` and the FSM). The store exposes:

```ts
class VoiceCallStore {
  /** Send an interrupt custom message to abort the agent's current run.
   *  No phase change — the call stays connected. */
  async abortAgent(): Promise<void>;
}
```

The store-side implementation routes through `seams.sendCommand` with the existing protocol shape; tests already have the seam fake.

#### Agent state derivation (lives in `CallingMode.svelte` / a small derive helper)

```ts
type AgentState = 'listening' | 'thinking' | 'speaking';

function deriveAgentState(args: {
  isStreaming: boolean; // sessionRegistry.viewed.isStreaming
  remoteAudioLevel: number; // 0..1, sampled from the WebRTC inbound audio track
  speakingThreshold: number; // ~0.02 — tunable
}): AgentState;
```

Rules:

- `remoteAudioLevel > speakingThreshold` → `speaking` (highest priority — the user is actually hearing audio).
- else if `isStreaming` → `thinking` (worker is grinding, no audio out yet).
- else → `listening` (default).

The **continuous** `remoteAudioLevel` is also passed to `CallStateRow.svelte` directly (alongside the discrete `AgentState`) so the speaking visual can pulse in sync with TTS amplitude. The discrete state controls _which_ visual treatment is shown; the continuous level drives the _speaking_ treatment's animation. Listening and thinking ignore the level.

`remoteAudioLevel` is sampled at ~10Hz by the calling-mode component via an `AnalyserNode` attached to the inbound `MediaStream` (or `getStats()` `audioLevel` if simpler — implementation choice). The seam to obtain the inbound stream is added to `voice-call-seams.ts`:

```ts
export interface VoiceCallSeams {
  // ... existing seams unchanged ...
  /** Returns the most recent inbound audio level (0..1) from the active peer.
   *  Null when no peer / no inbound track. */
  getRemoteAudioLevel?: () => number | null;
}
```

In tests, the seam is a fake returning a controlled number; in the browser, it's wired through the existing peer connection's `getStats()` or an analyser.

#### `CallStateRow.svelte` visual contract

The component accepts `{ state: AgentState; remoteAudioLevel: number }` and renders one of three treatments — chosen so that the three states are recognisable at a glance from a few feet away:

| State       | Color | Animation                                                                     |
| ----------- | ----- | ----------------------------------------------------------------------------- |
| `listening` | cyan  | slow breathe (~2s period, opacity 0.6–1.0)                                    |
| `thinking`  | amber | faster pulse (~0.6s period)                                                   |
| `speaking`  | green | scale/opacity driven by `remoteAudioLevel` (instantaneous, smoothed slightly) |

State-word label sits next to the pulse: "listening" / "thinking" / "speaking". The colors and animation periods above are the architectural contract; exact CSS values are implementation detail.

#### `MessageList` props extension

```ts
interface MessageListProps {
  // ... existing props ...
  /** When true, disables all pointer interaction on rendered messages
   *  (no scroll-on-tap, no per-message TTS button click, no copy buttons).
   *  Visual rendering is unchanged. Default: false. */
  readOnly?: boolean;
}
```

The `readOnly` flag is implemented as a CSS `pointer-events: none` on the inner content container plus removal of the input/footer affordances. Auto-scroll-to-bottom still functions (it's not user-driven).

#### `CallGestureZone.svelte` gesture contract

The gesture zone is the single bottom region of the calling-mode screen. It is the only touch-active surface. **Sizing:** the zone is `min(25vh, 200px)` tall with a 120px floor on small viewports, leaving the remainder of the screen to the header (top, fixed-ish) and the transcript (middle, flex). This is large enough for an unambiguous 80px swipe without eating the transcript area on phone-sized screens.

- **Tap** — `pointerdown` followed by `pointerup` within the zone, with total movement < 10px and duration < 300ms. Maps to `voiceCallStore.toggleMute()` and plays the corresponding mute-on/mute-off cue based on the _new_ mute state.
- **Swipe up** — `pointerdown` in the zone, followed by `pointerup` (anywhere) with `Δy ≤ -80px`. Maps to `voiceCallStore.endCall()`. No audio cue (the call audio dropping is its own cue).
- **Swipe down** — `pointerdown` in the zone, followed by `pointerup` (anywhere) with `Δy ≥ +80px`. Maps to `voiceCallStore.abortAgent()` and plays the abort-confirm cue.

Pointer events are captured (`setPointerCapture`) on `pointerdown` so swipes that start in the zone but end outside still register. Multi-touch is treated as cancel (releases capture, no action). The zone visually previews swipes by translating its hint chevrons opposite to finger motion (cosmetic, optional polish).

#### `CallAudioCues` module

```ts
// client/src/lib/call-audio-cues.ts
export interface CallAudioCues {
  playMuteOn(): void; // higher-pitched short beep
  playMuteOff(): void; // lower-pitched short beep
  playAbortConfirm(): void; // distinct double-beep
}

export function createCallAudioCues(audioContextFactory?: () => AudioContext): CallAudioCues;
```

- Lazy-creates a single `AudioContext` on first call (some browsers require a user gesture; the first call always follows a tap/swipe so this is safe).
- Each cue is a short `OscillatorNode` (sine) with a ~80ms gain envelope (attack-decay), ducked enough not to clash with the WebRTC remote audio.
- The `audioContextFactory` parameter is the test seam.

#### `SessionSettingsDialog` row addition

A new row is added to the existing dialog (between "Thinking" and the connection-status block):

```svelte
<div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
  <span class="text-muted-foreground">Voice call</span>
  <CallButton sessionId={session?.sessionId} variant="dialog-row" />
</div>
```

`CallButton.svelte` gains an optional `variant` prop with two visual treatments:

- `'inline'` (default, used by desktop `StatusBar.svelte`) — current 6×6 muted icon button.
- `'dialog-row'` — wider button labelled "Start call" (green) / "End call" (red) sized to fit the dialog row, mirroring the visual approach of the inline mobile-header button it replaces.

The mobile-header phone button block in `+layout.svelte` (the `{@const callState ...}` block currently rendering the green/red phone button) is deleted.

### Deferred (acknowledged from brainstorm open questions, not addressed in v1)

- **Accessibility** — screen-reader semantics over the touch-disabled middle, large-text scaling for the gesture hints, and color-blind alternatives to the state-pulse colors are deferred. The pulse currently leans entirely on color; a follow-up should add shape/icon redundancy. Noted as known v1 limitation.
- **Theming** — calling mode inherits the surrounding app theme. No always-dark / night-driving treatment in v1; revisit if real-world driving use shows the day theme is too bright.
- **Audio-cue ducking** — cues are ~80ms beeps; no ducking of the WebRTC remote audio while a cue plays. If cues prove to clip TTS audibly in practice, add ducking via a `GainNode` on the inbound audio path; for v1 we accept the occasional clipped syllable as the cost of staying simple.

### Non-changes worth being explicit about

- **Server / protocol / voice extension** — untouched. Abort is sent via an interrupt custom message that already exists; agent state is derived purely client-side from existing data.
- **CallBanner.svelte** — fully deleted. No fallback path; calling mode is the only in-call UI.
- **Reconnection / network failure** — no new state. The existing `call_ended` event drops the call; calling mode unmounts via the conditional in `+page.svelte`. Any error surfaces as a transient toast in the normal view (existing toast / banner mechanism, no new component required).
- **PWA backgrounding / iOS** — not designed around. Inherits whatever Android Chrome does today.
- **Desktop layout** — unchanged. The mobile-into-dialog move is mobile-only.
