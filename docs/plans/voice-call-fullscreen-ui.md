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

The store also gains an **abort capability** invoked by the gesture zone. The wire frame is the existing `AbortCommand` (`type: 'abort'`, sessionId-bearing) already in `shared/src/protocol.ts`. (Note: `VOICE_INTERRUPT_CUSTOM_TYPE` is a _persisted-entry_ customType tag the voice extension stamps on scrollback when it observes a rollback/abort — not a client→server command type, and therefore not what the store sends here.) The store exposes:

```ts
class VoiceCallStore {
  /** Send an interrupt custom message to abort the agent's current run.
   *  No phase change — the call stays connected. */
  async abortAgent(): Promise<void>;
}
```

The store-side implementation routes through `seams.sendCommand` with an `AbortCommand`; tests already have the seam fake.

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

## Tests

**Pre-test-write commit:** `da7b78c486b375cd5bcbe83e39c7fac87334bf5d`

### Interface Files

- `client/src/lib/stores/voice-call.svelte.ts` — extended `VoiceCallState` with `startedAt: number | null`; extended `VoiceCallSeams` with optional `getRemoteAudioLevel(): number | null` and `now(): number` test seams; added `VoiceCallStore.abortAgent()` (stub routes through `seams.sendCommand` with the existing protocol shape, leaves phase unchanged); `startedAt` is set on the first transition into `connected` and cleared on every transition back to `idle`.
- `client/src/lib/components/call-state.ts` — `AgentState` union, `deriveAgentState({ isStreaming, remoteAudioLevel, speakingThreshold })`, and `formatCallDuration(elapsedMs)` for the call-header `MM:SS` (or `H:MM:SS`) display.
- `client/src/lib/components/call-gesture.ts` — pointer-sample gesture recogniser used by `CallGestureZone.svelte`. Returns `'tap' | 'swipe-up' | 'swipe-down' | null` from a pointerdown→pointerup pair plus tunable thresholds.
- `client/src/lib/call-audio-cues.ts` — `CallAudioCues` interface and `createCallAudioCues(audioContextFactory?)` factory. Lazy-creates one `AudioContext`, synthesises mute-on / mute-off / abort-confirm beeps via `OscillatorNode`s with short envelopes; the factory parameter is the test seam.

### Test Files

- `client/src/lib/stores/voice-call.svelte.test.ts` — extended with two new describe blocks: `startedAt` lifecycle (set on first `call_ready`, idempotent on re-entry, cleared on `call_ended` and on `endCall`) and `abortAgent` behaviour (sends a session-scoped command, no phase change, no-op while idle, swallows send-command errors). Existing initial-state assertion updated to include `startedAt: null`.
- `client/src/lib/components/call-state.test.ts` — exercises `deriveAgentState` priority rules and `formatCallDuration` formatting (sub-minute, minute, hour-plus, truncation, negative clamp).
- `client/src/lib/components/call-gesture.test.ts` — exercises `recognizeCallGesture` for tap/swipe-up/swipe-down classification, threshold edges, ambiguous mid-zone movement, and custom thresholds.
- `client/src/lib/call-audio-cues.test.ts` — exercises `createCallAudioCues` against an in-memory `AudioContext` fake: lazy context creation, single-beep cues, mute-on > mute-off pitch ordering, double-beep abort cue, destination connection, and finite scheduled durations.

### Behaviors Covered

#### `VoiceCallStore` — `startedAt`

- `startedAt` is `null` while in `binding` and `connecting`.
- `startedAt` is set to "now" on the first transition into `connected` (the `now` seam pins time in tests).
- A second `call_ready` event for the same session does not reset `startedAt`.
- `startedAt` is cleared whenever the store returns to `idle` (via `call_ended` or `endCall`).

#### `VoiceCallStore` — `abortAgent`

- While connected: invokes `seams.sendCommand` exactly once with the active `sessionId`, and the call's phase is unchanged.
- While idle: is a no-op — no command is sent.
- If `seams.sendCommand` rejects, the error is swallowed and the call stays connected.

#### `deriveAgentState`

- Returns `'listening'` when neither audio is playing nor the worker is streaming.
- Returns `'thinking'` when the worker is streaming and no audio is playing.
- Returns `'speaking'` when `remoteAudioLevel > speakingThreshold` — even if `isStreaming` is also true (audio out is the strongest signal).
- The threshold is exclusive: a level exactly equal to the threshold is not yet `'speaking'`.

#### `formatCallDuration`

- Sub-minute durations render as `MM:SS` (e.g. `00:01`, `00:59`).
- Minute-plus durations render as `MM:SS` up to 59:59.
- Hour-plus durations render as `H:MM:SS`.
- Sub-second remainders are truncated, not rounded.
- Negative values clamp to `00:00`.

#### `recognizeCallGesture`

- A small (≤10px), fast (≤300ms) pointerdown→pointerup is a `tap`.
- A drag with `Δy ≤ -80px` is a `swipe-up`; with `Δy ≥ +80px` is a `swipe-down`.
- The 80px swipe threshold is inclusive.
- Movements between the tap and swipe thresholds (e.g. 70px drag, 20px slow drift) are unrecognised (`null`) — no spurious gestures.
- Custom thresholds override the defaults.

#### `createCallAudioCues`

- The `AudioContext` is constructed lazily on the first cue invocation, never up-front. Subsequent cues reuse the same context.
- `playMuteOn` schedules a single oscillator beep at a higher pitch than `playMuteOff` (so the user can distinguish mute-on from mute-off by ear).
- `playAbortConfirm` schedules two oscillators with the second starting after the first — a double-beep distinguishable from the single mute cue.
- Every cue routes through to `audioContext.destination`.
- Each scheduled oscillator has `stop > start` (a finite, non-zero envelope).

**Review status:** approved

## Steps

**Pre-implementation commit:** `c5354ac3eb246cd540d92bd167e838de74f8dacc`

All behavioural helpers (`call-state.ts`, `call-gesture.ts`, `call-audio-cues.ts`) and the `VoiceCallStore` extensions (`startedAt`, `abortAgent`, `getRemoteAudioLevel` / `now` seams) already exist from the test-write phase and have passing unit tests — they are not re-listed below. The remaining work is wiring the browser seam, the new Svelte UI subtree, the prop additions on existing components, the conditional render in `+page.svelte`, and the deletions.

### Step 1: Implement `getRemoteAudioLevel` in the browser voice-call seams

In `client/src/lib/stores/voice-call-seams.ts`, the `createBrowserVoiceCallSeams` factory currently omits `getRemoteAudioLevel`. Add it.

- Hold the most recent inbound audio level on the seams closure (a number, `null` initially).
- Track the inbound `MediaStreamTrack` already discovered in the existing `pc.addEventListener('track', ...)` handler. When an audio track arrives, attach it (via `new MediaStream([track])`) to a lazily-created `AudioContext` + `AnalyserNode` (`fftSize: 512`, `smoothingTimeConstant: 0.4`). Drop the analyser when the track ends or the peer closes.
- Sample the analyser at ~10Hz from a `setInterval`. Convert the time-domain byte buffer to a normalised 0..1 RMS and store it as the latest level.
- Return the cached level from `getRemoteAudioLevel(): number | null`. Return `null` when there is no analyser or the peer is closed. Tear down the interval, analyser and `AudioContext` in the existing peer `close()` path.
- Expose the seam on the returned `VoiceCallSeams` object.

**Verify:** `pnpm --filter @pimote/client check` passes; the existing voice-call test suite still passes; manual smoke (browser console: `voiceCallStore.seams.getRemoteAudioLevel?.()`) returns a number while remote audio is playing during a call.
**Status:** done

### Step 2: Add `readOnly` prop to `MessageList.svelte`

In `client/src/lib/components/MessageList.svelte`:

- Declare a Props block (currently the component takes no props):
  ```ts
  interface Props {
    /** When true, disables pointer interaction on rendered messages. Default: false. */
    readOnly?: boolean;
  }
  let { readOnly = false }: Props = $props();
  ```
- On the inner content wrapper that renders the `Message`s, conditionally apply a class that sets `pointer-events: none` (e.g. `class:pointer-events-none={readOnly}`). Auto-scroll behaviour is unaffected because it isn't user-driven.
- Suppress the per-message draft / fork-prompt UI when `readOnly` is true (the dialog flow at the top of the file): if `readOnly`, do not call `promptDraftChoice` and do not open `draftDialogOpen`.
- Do not gate `connection.send` calls behind `readOnly` — the flag is purely a visual / pointer concern.

**Verify:** existing tests still pass; rendering `<MessageList readOnly />` in a sandbox does not respond to taps on messages but still auto-scrolls when new content arrives.
**Status:** done

### Step 3: Add `variant` prop to `CallButton.svelte`

In `client/src/lib/components/CallButton.svelte`:

- Extend the `Props` interface:
  ```ts
  interface Props {
    sessionId?: string;
    variant?: 'inline' | 'dialog-row';
  }
  let { sessionId, variant = 'inline' }: Props = $props();
  ```
- Compute `inCall` (call bound to this `sessionId` and phase ≠ idle) so the button can flip between Start / End behaviour. The current implementation only supports `startCall`; the `dialog-row` variant must also call `endCall` when `inCall`.
- Render two distinct DOM bodies based on `variant`:
  - `inline` — current 6×6 muted icon button (unchanged visuals, unchanged Start-only behaviour for backwards-compat with `StatusBar`).
  - `dialog-row` — wider button labelled `Start call` (green: `bg-emerald-500/90 text-white`) when not in call, `End call` (red: `bg-destructive text-destructive-foreground`) when `inCall`. Icon: `Phone` (start) / `PhoneOff` (end). Width fills the dialog row (`w-32` or similar — match the visual of the deleted mobile-header button).
- `onClick` for `dialog-row` routes to `voiceCallStore.endCall()` when `inCall`, else `voiceCallStore.startCall(sessionId)`.

**Verify:** the existing `StatusBar` usage (`<CallButton sessionId={...} />`) renders unchanged; dropping `<CallButton sessionId={...} variant="dialog-row" />` into a page renders the wider button and toggles between green Start / red End.
**Status:** done

### Step 4: Add Voice call row to `SessionSettingsDialog.svelte`

In `client/src/lib/components/SessionSettingsDialog.svelte`:

- Import `CallButton` from `./CallButton.svelte`.
- Insert a new row between the existing `Thinking` row and the `Context` row:
  ```svelte
  <div class="border-border/60 flex items-center justify-between gap-3 border-t px-3 py-3">
    <span class="text-muted-foreground">Voice call</span>
    <CallButton sessionId={session?.sessionId} variant="dialog-row" />
  </div>
  ```
- `session` is the existing reactive session reference already in this file; reuse it. Do not gate the row on connection state — disabled-while-no-session is handled inside `CallButton`.

**Verify:** opening the session settings dialog on mobile shows the new Voice call row with a Start / End call button; clicking it toggles a call. Existing rows still render in the right order.
**Status:** done

### Step 5: Create `client/src/lib/components/CallStateRow.svelte`

New component — the agent-state pulse + label row.

- Props:
  ```ts
  interface Props {
    state: AgentState; // imported from './call-state.js'
    remoteAudioLevel: number; // 0..1
  }
  ```
- Layout: a horizontal flex row, gap-2, items-center: `[pulse-dot]  [state-word]`.
- Visual treatments by `state`:
  - `listening` — solid cyan dot (`bg-cyan-400`) with a slow breathe via Tailwind `animate-pulse` (or a custom 2s opacity 0.6→1.0 keyframe in a `<style>` block) and label `"listening"`.
  - `thinking` — amber dot (`bg-amber-400`) with a faster ~0.6s pulse and label `"thinking"`.
  - `speaking` — green dot (`bg-emerald-400`); its scale and opacity are computed from `remoteAudioLevel` (e.g. `transform: scale(${1 + level * 0.6})`, `opacity: ${0.6 + level * 0.4}`) applied via inline `style:` directives. Slight CSS smoothing (`transition: transform 80ms, opacity 80ms`). Label `"speaking"`.
- The label uses `text-sm font-medium text-foreground` and is read-only.
- The dot is `size-3 rounded-full`.
- The component must not own state — it is a pure render of its props.

**Verify:** mounting the component with each of the three states renders the right colour, animation, and label; passing varying `remoteAudioLevel` values to the `speaking` state visibly modulates the dot size.
**Status:** done

### Step 6: Create `client/src/lib/components/CallHeader.svelte`

New component — the top region of calling mode. Shows session label, duration, mic state, and hosts `CallStateRow`.

- Props:
  ```ts
  interface Props {
    sessionDisplayName: string | null;
    folderPath: string | null;
    startedAt: number | null; // from VoiceCallStore.state.startedAt
    micMuted: boolean;
    agentState: AgentState;
    remoteAudioLevel: number;
  }
  ```
- Drive a `now: number = $state(Date.now())` value updated every 1000ms via a `setInterval` in `$effect(() => { ... return () => clearInterval(...); })`. Compute `elapsedMs = startedAt ? now - startedAt : 0` and pass through `formatCallDuration` (from `./call-state.js`) to render `MM:SS` / `H:MM:SS`.
- Layout (top-aligned, no flex-grow): a vertical stack with `px-4 pt-6 pb-3 gap-2`:
  1. Top row — small text: project label (`folderPath` basename or `'session'`) + `·` + `sessionDisplayName ?? 'Session'`, truncated.
  2. Big duration row — `text-3xl tabular-nums text-foreground`.
  3. Mic state — small row: `Mic` icon (or `MicOff` when `micMuted`) plus the literal text `"Muted"` / `"Live"`. Use the same lucide imports the existing `CallBanner` used.
  4. `<CallStateRow state={agentState} remoteAudioLevel={remoteAudioLevel} />`.
- The component is stateless beyond the ticking `now`. No store reads — values come in as props.

**Verify:** mounting the component with a fixed `startedAt = Date.now() - 65000` shows `01:05` and ticks; `micMuted` toggles the mic icon; the state row renders.
**Status:** done

### Step 7: Create `client/src/lib/components/CallGestureZone.svelte`

New component — the bottom region. Owns pointer handling and triggers store actions + audio cues.

- Props: none. Consumes `voiceCallStore` directly (singleton import) and the cues factory (see below).
- Sizing: outermost element `style="height: min(25vh, 200px); min-height: 120px;"` plus `relative w-full select-none touch-none`.
- Render the three permanently-visible hint labels:
  - Top hint — `ChevronUp` icon + `"Hang up"` aligned to the top-centre.
  - Centre hint — `"Tap to mute"` (or `"Tap to unmute"` when `voiceCallStore.state.micMuted`).
  - Bottom hint — `ChevronDown` icon + `"Abort"` aligned to the bottom-centre.
- Pointer handling:
  - Module-scope (or `$state`) singleton `cues = createCallAudioCues()` — instantiated lazily on first cue. Import from `$lib/call-audio-cues.js`.
  - On `pointerdown` (primary pointer only — `event.isPrimary`): record `start: PointerSample` from `event.clientX/Y` and `event.timeStamp`. Call `event.target.setPointerCapture(event.pointerId)`. Stash `pointerId`.
  - On `pointerup` matching the captured `pointerId`: build `end: PointerSample` and call `recognizeCallGesture(start, end)` from `$lib/components/call-gesture.js`. Dispatch:
    - `'tap'` → `voiceCallStore.toggleMute()`. Then play `cues.playMuteOn()` if the new `voiceCallStore.state.micMuted` is true, else `cues.playMuteOff()`.
    - `'swipe-up'` → `voiceCallStore.endCall().catch(() => {})`. No cue.
    - `'swipe-down'` → `voiceCallStore.abortAgent().catch(() => {})`. Then `cues.playAbortConfirm()`.
    - `null` → no action.
      Always release pointer capture and clear `start` / `pointerId`.
  - On `pointercancel` or a second concurrent `pointerdown` with a different `pointerId`: cancel — release capture, clear state, no action.
- Cosmetic: optionally translate the hint chevrons by ~`-dy * 0.3px` while the pointer is down to preview swipe direction. Skip if it complicates the diff.

**Verify:** unit-test the gesture recognizer is already covered; manually confirm that tap toggles mute and plays the corresponding cue, swipe-up ends the call, swipe-down sends abort and plays the double-beep, and a swipe that begins in the zone but ends outside still registers.
**Status:** done

### Step 8: Create `client/src/lib/components/CallingMode.svelte`

New component — top-level full-screen container.

- Props: none. Reads `voiceCallStore` and `sessionRegistry.viewed` directly.
- Outer layout: `fixed inset-0 z-40 flex flex-col bg-background text-foreground` (covers everything below modal layers but above the regular page). The container is rendered inside `+page.svelte` (Step 9), so z-index is only relative to in-page content. If any toasts / dialogs need to overlay, they already use higher z-indices (verify with a quick rg before merging).
- Internal regions:
  1. `<CallHeader ... />` — fixed-height top region (its content determines height).
  2. Middle region: a `flex-1 min-h-0 overflow-hidden` wrapper containing `<MessageList readOnly />`.
  3. `<CallGestureZone />` — bottom.
- Audio level sampling: keep a local `remoteAudioLevel = $state(0)` and a `$effect` that runs a `setInterval` at 100ms reading `voiceCallStore.seams?.getRemoteAudioLevel?.() ?? 0`. (`seams` is private — instead expose the level via `voiceCallStore.getRemoteAudioLevel?.()` if more convenient, or call the seam through a small helper added to `voice-call-store.ts`. If a helper is needed, add it: `export function getRemoteAudioLevel(): number { return voiceSeams.getRemoteAudioLevel?.() ?? 0; }` colocated with the singleton.)
- Compute `agentState` via `deriveAgentState({ isStreaming: !!sessionRegistry.viewed?.isStreaming, remoteAudioLevel, speakingThreshold: 0.02 })`.
- Compute `sessionDisplayName` via the existing `getSessionDisplayName` helper from `$lib/session-summary.js`; pass `folderPath = sessionRegistry.viewed?.folderPath ?? null`.
- No teardown logic — the parent unmounts the component when phase returns to idle.

**Verify:** rendering `<CallingMode />` while a call is connected covers the screen, shows the message transcript with no taps registering, ticks the duration, animates the state pulse, and the gesture zone responds.
**Status:** done

### Step 9: Conditionally render `CallingMode` in `+page.svelte`

In `client/src/routes/+page.svelte`:

- Import `CallingMode from '$lib/components/CallingMode.svelte'` and `voiceCallStore from '$lib/stores/voice-call-store.js'`.
- Compute `inCall = $derived(voiceCallStore.state.phase !== 'idle' && voiceCallStore.state.sessionId === sessionRegistry.viewedSessionId)`.
- Restructure the active-session branch so that, when `inCall` is true, only `<CallingMode />` is rendered; when false, the existing `StatusBar` / `MobileRuntimeStatus` / takeover banners / `MessageList` / `InlineSelect` / `PendingSteeringMessages` / `ActiveSessionBar` / `InputBar` tree is rendered as today:
  ```svelte
  {#if sessionRegistry.viewedSessionId}
    {#if inCall}
      <CallingMode />
    {:else}
      <div class="flex min-h-0 flex-1 flex-col">... existing tree ...</div>
    {/if}
  {:else}
    ... existing landing branch ...
  {/if}
  ```
- The landing branch is unchanged.

**Verify:** start a call from the status bar — the entire chat surface is replaced by calling mode; end the call — the normal chat surface returns with no flicker. Switching to a different session while a call is bound to another session shows the chat surface for the viewed session (calling mode is bound to the call's sessionId, not the viewed one).
**Status:** done

### Step 10: Remove the inline mobile phone button from `+layout.svelte`

In `client/src/routes/+layout.svelte`:

- Delete the `{#if sessionRegistry.viewedSessionId} {@const sid ...} {@const callState ...} {@const inCall ...} <button ...>` block (lines around 274–296) that renders the green/red phone button next to `SessionSettingsDialog`.
- Drop the `Phone` lucide import and the `voiceCallStore` import if they have no other use in this file (re-grep after deletion to confirm). The `import '$lib/stores/voice-call-store.js'` side-effect import must remain so server-event subscription still happens at app boot.

**Verify:** the mobile header no longer shows the phone button; the entry point on mobile is now `SessionSettingsDialog → Voice call row`. Desktop is unaffected (it never used this button).
**Status:** done

### Step 11: Delete `CallBanner.svelte` and remove its mount

- Delete `client/src/lib/components/CallBanner.svelte`.
- In `client/src/routes/+layout.svelte`, remove the `import CallBanner from '$lib/components/CallBanner.svelte';` line and the `<CallBanner />` element (currently mounted just below the header).
- `rg "CallBanner" client` must return zero hits after this step.

**Verify:** `pnpm --filter @pimote/client check` passes (no dangling import); during a call, the banner no longer appears — calling mode is the only in-call UI.
**Status:** done

### Step 12: Refresh the codemap

Update `codemap.md` to reflect the new files and removed file:

- Add entries under `Client → Files`: `CallingMode.svelte`, `CallHeader.svelte`, `CallStateRow.svelte`, `CallGestureZone.svelte`, `call-state.ts`, `call-state.test.ts`, `call-gesture.ts`, `call-gesture.test.ts`, `call-audio-cues.ts`, `call-audio-cues.test.ts`.
- Remove the `CallBanner.svelte` entry.
- Update the existing `+layout.svelte` entry to drop `CallBanner` from the global overlay list.
- Update the `voice-call-seams.ts` entry to mention `getRemoteAudioLevel` (analyser-backed RMS sampling of the inbound peer track).
- Update the `voice-call.svelte.ts` entry to mention the `startedAt` field and `abortAgent()` method.

**Verify:** the new files are documented; `rg CallBanner codemap.md` returns nothing.
**Status:** done

### Step 13: End-to-end smoke

Run the full client test suite and the manual journey:

- `pnpm --filter @pimote/client test` — green.
- `pnpm --filter @pimote/client check` — green.
- `pnpm -w lint` — green.
- `tools/manual-test/PLAN.md` journey 8 (voice call) — re-walk on Android Chrome PWA. Expect: mobile entry via Settings dialog row, calling-mode covers the chat, tap-to-mute plays a beep, swipe-up hangs up, swipe-down aborts and plays the double-beep, the duration ticks, the agent-state pulse cycles listening → thinking → speaking → listening over a typical exchange.

**Verify:** client `npm run check` and `npx vitest run` both green (358 tests pass). `npm run lint` has 47 pre-existing errors in `scripts/*.mjs` and `server/src/voice/index.ts` (concurrent unrelated changes by the user) — none in files touched by this plan; `npx eslint` against this plan's files passes clean. Manual journey 8 (Android Chrome PWA voice call) deferred to user — code paths verified by unit tests and svelte-check.
**Status:** done
