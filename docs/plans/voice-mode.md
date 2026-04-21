# Plan: Voice mode for pimote

## Context

Give pimote a voice modality. Speechmux is the voice engine; voxcoder contributes the interpreter pattern (ideas and prompts, not code). See [`docs/brainstorms/voice-mode.md`](../brainstorms/voice-mode.md).

**v1 deliberately narrows the brainstorm** to de-risk the core hypothesis — that a single pi session can alternate system prompts and extension activation across calls without requiring structural pi-SDK changes — before committing to an Android client:

- **v1 voice client is the PWA**, not Android. Browser WebRTC to speechmux; PWA's existing pimote WS is reused for call control.
- **Android / Android Auto / telephony SDK / sessions-as-contacts** are deferred to v2. The brainstorm's decisions in those areas remain correct for when v2 arrives.
- **PWA is _not_ text-only in v1** (reverses a brainstorm decision explicitly).

Everything else from the brainstorm stands: interpreter-as-primary with `my-pi` subagent workers, speechmux WS `LlmBackend` as the pimote ↔ speechmux seam, WebRTC + Cloudflare Calls TURN, single-owner session semantics with displacement, best-effort character-precision walk-back on LLM context (persisted scrollback stays append-only).

## Architecture

### Impacted Modules

- **Protocol** (`shared/`) — extended with `call_bind` / `call_end` commands and `call_bind_response` / `call_ready` / `call_ended` / `call_status` events. New `CustomEntry` type tag `pimote:voice:interrupt` for walk-back markers. No breaking changes to existing message types. Snake_case naming to match existing convention.

- **Server** (`server/`) — `openSession` configures `resourceLoaderOptions` to include the voice extension factory for every session (dormant by default). New `voice-orchestrator.ts` module owns speechmux sidecar lifecycle, call-bind routing, and per-session activation signalling. `ws-handler.ts` routes `call_bind` / `call_end` to the orchestrator. `config.ts` gains `defaultInterpreterModel`, `defaultWorkerModel`, and speechmux binary / endpoint config. Existing single-owner displacement path is the sole ownership model for calls. UI-bridge (`extension-ui-bridge.ts`) rejects requests with a `ui_bridge_disabled_in_voice_mode` error when the session has an active call.

- **Client** (`client/`) — new call control (per-session "Call" button + in-call banner with mute / hangup). New `client/src/lib/stores/voice-call.svelte.ts` store owning the `RTCPeerConnection`, `getUserMedia` stream, speechmux `/signal` WS client, and reactive call state. Existing scrollback and panels continue to render during a call (no voice-specific rendering work in v1).

- **Panels** (`packages/panels/`) — unchanged in v1. (Future: voice extension may publish an in-call status card; not required.)

### New Modules

- **`packages/voice/`** — new workspace package. The pimote voice extension (loaded into every pi session, dormant by default). Owns:
  - Interpreter `INTERPRETER_PROMPT` (adapted from voxcoder, multimodal placeholders removed — PWA v1 is voice-only; text channel is the PWA rendering the scrollback separately, not a direct text input to the interpreter).
  - The `speak(text)` pi custom tool.
  - The `before_agent_start` hook that injects the interpreter prompt when active.
  - The `context` hook that rewrites the assistant-history tail on the next LLM call, based on the current `heard_text` watermark and captured in-flight streaming content, when active.
  - A `message_update` subscriber that captures the current streaming assistant message's content blocks continuously, so on abort the extension retains the pre-abort content (pi does not persist it).
  - The `tool_call` hook that streams `speak(...)` invocations to speechmux as `{type:"token", text}` frames and emits `{type:"end"}` on turn end.
  - The speechmux WS client (talks speechmux's `LlmBackend` WS protocol as the harness — see [`speechmux/docs/llm-ws-protocol.md`](../../../speechmux/docs/llm-ws-protocol.md)).
  - Activation state machine (dormant / active) driven by EventBus messages from the orchestrator.
  - Dependencies: pi SDK types (`ExtensionAPI`, `ExtensionContext`, hook types), `@pimote/shared` protocol types, `ws` for the speechmux client.

- **`server/src/voice-orchestrator.ts`** — new server module. Single responsibility: own the speechmux sidecar process lifecycle and the call-bind dispatch. Spawns speechmux at server start, kills it at server shutdown. On `call_bind` for session `S` with client `C`: mints a per-call auth token, tells speechmux about the token (via whatever admin surface speechmux grows), displaces any existing owner of `S` (standard `session_closed{reason:'displaced'}` path), registers `C` as the new owner, emits `pimote:voice:activate { sessionId, speechmuxWsUrl, callToken }` on session `S`'s EventBus. On `call_end`: emits `pimote:voice:deactivate { sessionId }` on the EventBus; the extension tears down its speechmux WS client. Publishes `call_ready` once speechmux reports the WebRTC peer connected.

### Interfaces

#### Wire protocol extensions (`shared/src/protocol.ts`)

New client → server commands:

```typescript
interface CallBindCommand {
  type: 'call_bind';
  id: string;
  sessionId: string;
  force?: boolean; // Displace existing owner if true (default false)
}

interface CallEndCommand {
  type: 'call_end';
  id: string;
  sessionId: string;
}
```

New server → client messages:

```typescript
interface CallBindResponse {
  type: 'call_bind_response';
  id: string;
  // Endpoint the client opens a WebRTC-signalling WebSocket to.
  // Speechmux's own publicly-exposed /signal endpoint (see DR-014 on speechmux side).
  webrtcSignalUrl: string;
  // Per-call shared secret; sent by client in speechmux's `hello.token` frame.
  callToken: string;
  // Cloudflare Realtime TURN credentials (from speechmux's existing mint flow).
  turn: {
    urls: string[];
    username: string;
    credential: string;
  };
}

interface CallReadyEvent {
  type: 'call_ready';
  sessionId: string;
}

interface CallEndedEvent {
  type: 'call_ended';
  sessionId: string;
  reason: 'user_hangup' | 'displaced' | 'server_ended' | 'error';
}

interface CallStatusEvent {
  type: 'call_status';
  sessionId: string;
  status: 'binding' | 'ringing' | 'connected' | 'ended';
}
```

Error responses use the existing response envelope; a failed `call_bind` (session not found, owned without `force`, orchestrator error) returns a standard error with a discriminable reason code (`call_bind_failed_session_not_found | call_bind_failed_owned | call_bind_failed_internal`).

Extensions receive `ui_bridge_disabled_in_voice_mode` as the rejection code when UI bridge is attempted on a call-owned session (bridge-side concern, not a new wire message).

#### Voice orchestrator (server)

```typescript
class VoiceOrchestrator {
  constructor(config: PimoteConfig, sessionManager: SessionManager);

  // Spawns speechmux sidecar. Throws if it fails to start within timeout.
  async start(): Promise<void>;

  // Kills speechmux. Idempotent.
  async stop(): Promise<void>;

  // Called by ws-handler for CallBindCommand. Returns the CallBindResponse payload
  // on success; throws a typed error on failure. Side-effects:
  // - displaces existing owner if force=true (via sessionManager);
  // - registers speechmux per-call auth token;
  // - emits pimote:voice:activate on the session's EventBus.
  async bindCall(args: { sessionId: string; clientConnection: ClientConnection; force: boolean }): Promise<Omit<CallBindResponse, 'type' | 'id'>>;

  // Called by ws-handler for CallEndCommand, or internally on displacement/error.
  // Emits pimote:voice:deactivate on the session's EventBus and broadcasts
  // CallEndedEvent to the former owner. Idempotent.
  async endCall(args: { sessionId: string; reason: CallEndedEvent['reason'] }): Promise<void>;
}
```

#### Voice extension (`@pimote/voice`)

Extension factory signature (consumed by `extensionFactories` in `resourceLoaderOptions`):

```typescript
function createVoiceExtension(config: {
  defaultInterpreterModel: { provider: string; modelId: string };
  defaultWorkerModel: { provider: string; modelId: string };
}): ExtensionFactory;
```

Runtime state machine (internal to the extension instance):

- `dormant` — default. Hooks are registered but are no-ops. `speak(text)` tool errors if called.
- `activating` — received `pimote:voice:activate`, connecting to speechmux WS. If connection fails, emits deactivate to orchestrator and returns to dormant.
- `active` — connected to speechmux. Hooks and tool are live. **On entry to this state**, the extension calls `session.sendUserMessage("<voice_call_started/>")` to trigger the interpreter's first turn; the `INTERPRETER_PROMPT` instructs the model how to greet when it sees this sentinel. This is the architectural mechanism for the "session-start greeting" behaviour the brainstorm imports from voxcoder. The sentinel is a synthetic user message, not real user speech, and is recorded in the session like any user message.
- `deactivating` — received `pimote:voice:deactivate`, tearing down speechmux WS and resetting walk-back watermark. Transitions to dormant.

Hook behaviour while `active`:

- `before_agent_start` — sets `event.systemPrompt = INTERPRETER_PROMPT + appendedUserSystemPrompt`. Sets session model to `defaultInterpreterModel` on first activation per session (persists via `session.setModel`).
- `context` — if a walk-back watermark is set (see speechmux frame handling below), rewrites the tail of `event.messages` so the LLM sees only what the user actually heard. Removes the trailing synthetic empty-text aborted assistant pi appends on abort, then inserts a reconstructed assistant message built from the captured streaming content and the `heard_text` watermark. Full contract below. Clears the watermark after applying.
- `tool_call` for `speak` — intercepts the tool call, streams `{type:"token", text}` frames to speechmux, returns a trivial success result so the agent loop advances. Emits `{type:"end"}` when the assistant turn's tool-call batch completes (via `turn_end` or equivalent event).
- Free-text (non-tool) assistant output — explicitly discarded from the audio channel. Scrollback still records it. No audio emission.

Speechmux frame handling (the extension is the harness consumer of speechmux's `LlmBackend` WS protocol):

- Incoming `{type:"user", text}` — calls `session.sendUserMessage(text)` (or `steer` / `followUp` if streaming per the `streamingBehavior` semantics).
- Incoming `{type:"abort"}` — stashes the current captured streaming snapshot, calls `session.abort()`, sets walk-back watermark to `""`. Appends `appendCustomMessageEntry("pimote:voice:interrupt", { heard_text: "", kind: "abort" }, false)` so the persisted log records that an interrupt occurred (even though pi itself leaves no assistant entry for the aborted turn — see pi abort semantics below).
- Incoming `{type:"rollback", heard_text}` — same as abort, but watermark = `heard_text`. Appends `appendCustomMessageEntry("pimote:voice:interrupt", { heard_text, kind: "rollback" }, false)`.

#### Pi abort semantics (pinned by plan, verified in `pi-agent-core` source)

These facts constrain the walk-back contract and were confirmed by reading pi-agent-core's `agent.js` and pi-coding-agent's `agent-session.js`:

1. Mid-stream `session.abort()` causes pi-agent-core to **discard** `agent.state.streamingMessage`. `message_end` never fires for the interrupted stream, so `sessionManager.appendMessage` is **not** called — the session JSONL file has **no entry** for the interrupted turn.
2. Pi-agent-core's `handleRunFailure` pushes a synthetic assistant message with `content: [{type:"text", text:""}]` and `stopReason:"aborted"` into `agent.state.messages` (in-memory only, not persisted).
3. The next LLM call's `context` hook receives `messages: AgentMessage[]` ending with that synthetic empty-text aborted message.
4. The `aborted: true` side-effect the brainstorm names is just `stopReason:"aborted"` on that synthetic message. The extension does nothing extra for it.

Because of (1), the voice extension **must capture streaming content itself** via a `message_update` subscriber. Pi does not hand the partial message back after abort.

#### Walk-back surgery contract

Given:

- `heardText: string` — watermark from the last `rollback`/`abort` speechmux frame.
- `captured: AgentMessage | null` — snapshot of the streaming assistant message's content blocks at abort time, accumulated by the extension's `message_update` subscriber.
- `context.messages: AgentMessage[]` — messages for the next LLM call, ending with pi's synthetic empty-text aborted assistant.

The `context` hook returns a new `messages` array as follows:

1. Remove the trailing synthetic empty-text aborted assistant (any `assistant` message where `stopReason === "aborted"` and the content is effectively empty).
2. If `heardText === ""` and `captured` has no user-heard content, append nothing — the aborted turn produced no audible output, so history omits it.
3. Otherwise, walk `captured.content` in order, accumulating `spoken` = concatenation of prior-kept `speak` tool_use `text` arguments:
   - **Non-`speak` block** (free text, other tool_use, thinking, etc.): if `spoken.length < heardText.length`, keep (part of model's process before cutoff); else drop (produced after cutoff).
   - **`speak` tool_use block**: let `arg = block.input.text`.
     - If `spoken + arg` is a prefix of `heardText`, keep whole; advance `spoken += arg`.
     - Else if `spoken.length < heardText.length`, truncate to `heardText.slice(spoken.length)` and stop.
     - Else drop.
   - For any `speak` tool_use that is dropped or truncated, the paired `tool_result` block (if present) is also dropped.
4. Append the reconstructed assistant message (retain `stopReason: "aborted"`).
5. Clear the watermark and captured snapshot.

**Idempotency.** If the hook runs without a new rollback having occurred (`watermark` is null), step 1 alone applies — drop any empty-text aborted assistants pi keeps appending to state on repeated interrupts. Steps 2–4 are skipped.

**Scope.** Only the most recent interrupted turn is reconstructed. Multiple interrupts without intervening completed turns collapse: earlier `speak` content is lost from LLM context, but persisted `pimote:voice:interrupt` markers preserve the fact that interrupts occurred.

#### Persisted scrollback fidelity (brainstorm correction)

The brainstorm said _"the PWA scrollback will show the full streamed assistant text — including text the user never heard."_ Given pi's abort semantics above, this is **not true**: pi persists no assistant entry for interrupted turns. The PWA sees live `message_update` events up to the abort, but after refresh / resync the JSONL file has nothing for the turn.

For v1 we accept this: **interrupted turns leave no assistant entry in the persisted scrollback.** The `pimote:voice:interrupt` custom-message entry is a marker that _something_ was said and cut off. If we later want "record of what was attempted" in the scrollback, the extension can be extended to `appendMessage(reconstructed)` on abort — additive, doesn't touch the v1 seam.

#### Cross-entry walk-back (out of scope for v1)

If the user barges in after the interpreter has completed a turn and started a new one, so the heard-cutoff lies across an entry boundary, v1 doesn't handle it — only the latest assistant turn is reconstructed. When we do add cross-entry walk-back, the correct primitive is `branch(fromId)` (moves the leaf pointer, records nothing) — **not** `branchWithSummary`, which would reinject the unheard continuation. Additive change; doesn't touch the v1 seam.

When the worker spawns via `my-pi` `subagent`, the interpreter's prompt instructs it to pass `model: defaultWorkerModel`. The extension does not intercept subagent spawning itself; it only configures the interpreter side.

#### Client voice-call controller (`client/src/lib/stores/voice-call.svelte.ts`)

```typescript
interface VoiceCallState {
  phase: 'idle' | 'binding' | 'connecting' | 'connected' | 'ending';
  sessionId: string | null;
  micMuted: boolean;
  lastError: string | null;
}

class VoiceCallStore {
  readonly state: VoiceCallState; // $state

  // Sends call_bind; on response, opens WebRTC peer to speechmux /signal;
  // updates state through binding -> connecting -> connected.
  async startCall(sessionId: string): Promise<void>;

  // Sends call_end and closes the peer connection.
  async endCall(): Promise<void>;

  toggleMute(): void;

  // Handles call_ready / call_ended / call_status events from pimote WS.
  handleServerEvent(event: CallReadyEvent | CallEndedEvent | CallStatusEvent): void;
}
```

The WebRTC signalling is speechmux's existing `hello → session → offer/answer → ice → bye` JSON over a WebSocket (`speechmux/src/webrtc_transport/signaling.rs`). The client sends its `callToken` in the `hello.token` field.

#### Orchestrator ↔ voice extension (EventBus)

New custom EventBus message types, namespaced `pimote:voice:*`. Payload shapes are exchanged on the _session-scoped_ EventBus (the one created per-slot in `session-manager.ts`):

```typescript
interface VoiceActivateMessage {
  type: 'pimote:voice:activate';
  sessionId: string;
  speechmuxWsUrl: string; // ws://... for the LlmBackend harness protocol
  callToken: string;
}

interface VoiceDeactivateMessage {
  type: 'pimote:voice:deactivate';
  sessionId: string;
}
```

Same pattern as panel data (DR-004); no new cross-process channel.

### Technology Choices

- **Speechmux as voice core** — already decided (brainstorm + exploration). Reusable as-is; v1 requires two small speechmux-side changes: (1) lift the WS `LlmBackend` listener out of the per-call loop so it binds at startup and persists across calls; (2) per-call auth tokens on `/signal` (replaces the single shared env token). These are speechmux-repo work, tracked separately. Alternatives considered: Web Speech APIs in the browser (rejected — no barge-in discipline, no shared engine for the future Android path); cloud ASR/TTS (rejected — latency + cost, loses speechmux's barge-in hook).

- **WebRTC via Cloudflare Realtime (TURN)** — already decided (brainstorm). Speechmux's existing DR-013 flow mints per-session TURN creds. Alternatives: self-hosted coturn (rejected — operational burden); peer-to-peer only (rejected — NAT traversal unreliable on cellular networks).

- **PWA as v1 voice client; Android deferred to v2** — _this plan's choice_. Primary reason: de-risks the core interpreter-prompt / extension-activation hypothesis in a build environment the team already owns (browser + TypeScript + SvelteKit). Alternatives: Android-first (the brainstorm's choice — defers the hypothesis validation behind a full mobile toolchain investment); native desktop client (rejected — same toolchain gap, no clear benefit over PWA). The protocol surface this plan defines (`call_bind` / `call_ready` / `call_ended` / `call_status` plus the speechmux signalling contract) is client-agnostic; the Android client in v2 will consume the same server interfaces.

- **EventBus for orchestrator ↔ extension signalling** — same mechanism pimote already uses for panel data (DR-004). No new IPC. Alternatives: direct extension-instance method calls from server (rejected — couples server to extension internals, harder to swap the extension); pi custom entries as the signalling channel (rejected — session-persistent when the signal is transient).

## Open questions carried from the brainstorm (not resolved here)

- Cross-subagent permission/question propagation. Deferred: v1 disables UI bridge during calls, so the question doesn't bind v1 correctness. Still an open architectural question for v2 if we want worker subagents to prompt the user over voice.
- Interpreter ↔ worker interaction cadence. Prompt-engineering, not architecture.
- Persisted-entry truncation upstream in pi (scrollback fidelity). Explicitly not blocking v1.
- Specific interpreter model choice. Config-driven; first real pick happens in impl.

## Tests

**Pre-test-write commit:** `ed1db86eb60fe1cc4eeadfbe302733bc3f7d0d9c`

### Interface Files

- `shared/src/protocol.ts` — wire protocol additions: `CallBindCommand`, `CallEndCommand`, `CallBindResponse`, `CallReadyEvent`, `CallEndedEvent`, `CallStatusEvent`, the `CallBindErrorCode` union, `CallEndReason`, `CallStatus`, the `VOICE_INTERRUPT_CUSTOM_TYPE` constant and `VoiceInterruptEntryData` payload shape, and the `UI_BRIDGE_DISABLED_IN_VOICE_MODE` error reason code. Extends `PimoteCommand` and `PimoteEvent` unions.
- `packages/voice/package.json`, `packages/voice/tsconfig.json`, `packages/voice/vitest.config.ts` — new `@pimote/voice` workspace package scaffolding.
- `packages/voice/src/index.ts` — public entry: `createVoiceExtension(options)` factory signature (stub that throws `not implemented`) plus re-exports of walk-back, state-machine, speechmux-client, and extension-runtime types.
- `packages/voice/src/state-machine.ts` — `VoiceExtensionState` union, `VoiceActivateMessage` / `VoiceDeactivateMessage` EventBus message shapes, `VOICE_CALL_STARTED_SENTINEL`.
- `packages/voice/src/speechmux-client.ts` — `SpeechmuxClient` interface + `SpeechmuxClientFactory` seam for the LlmBackend WS protocol; `IncomingFrame` / `OutgoingFrame` unions.
- `packages/voice/src/walk-back.ts` — pure `walkBack(input)` function implementing the walk-back surgery contract (steps 1–4), plus `isAbortedEmptyAssistant` helper.
- `packages/voice/src/extension-runtime.ts` — action-DSL reducers (`reduceActivate`, `reduceSpeechmuxOpened`, `reduceSpeechmuxFailed`, `reduceDeactivate`, `reduceSpeechmuxFrame`) that encode the extension's state machine and frame-handling contract as pure functions over a `VoiceRuntimeState`.
- `server/src/config.ts` — `PimoteConfig` extended with `defaultInterpreterModel`, `defaultWorkerModel`, and a nested `voice: VoiceConfig` section (speechmux binary, public signalling URL, internal LlmBackend WS URL); parsed through new `parseModelRef` / `parseVoiceConfig` helpers.
- `server/src/voice-orchestrator.ts` — `VoiceOrchestrator` class with `start` / `stop` / `bindCall` / `endCall` / `isCallActive`; `CallBindError` typed error carrying the `CallBindErrorCode`; `VoiceSessionBusResolver` seam for session-scoped EventBus lookup; `VoiceOrchestratorOptions` with injectable `mintCallToken`, `startSpeechmux`, `stopSpeechmux`, `displaceOwner`, `isOwnedByVoiceCall` hooks.
- `server/src/extension-ui-bridge.ts` — extended signature: `createExtensionUIBridge(slot, pushNotificationService?, options?)` where `options.isVoiceModeActive` predicate causes `select` / `confirm` / `input` / `editor` to reject with `ui_bridge_disabled_in_voice_mode` while a call owns the session.
- `client/src/lib/stores/voice-call.svelte.ts` — `VoiceCallStore` class with `startCall` / `endCall` / `toggleMute` / `handleServerEvent`; phase state machine `idle → binding → connecting → connected → ending`; constructor-injected `VoiceCallSeams` (sendCommand / createPeerConnection / getUserMedia / openSignaling) so tests can substitute in-memory fakes.
- `package.json` — added `packages/voice` to workspaces.

### Test Files

- `packages/voice/src/walk-back.test.ts` — walk-back surgery contract coverage: idempotent stripping of synthetic aborted assistants, empty-heard abort with no audible output, fully-heard speak chunks, speak truncation at the cutoff, non-speak blocks before / after the cutoff, paired `tool_result` dropping, the step-1 always-applies rule.
- `packages/voice/src/extension-runtime.test.ts` — state-machine transition coverage: activate → activating, speechmux-opened → active (with interpreter model set once + session-start sentinel emitted), speechmux failure → dormant + deactivate request, deactivate → dormant, duplicate / out-of-order activates ignored; speechmux frame routing (user / abort / rollback) produces the expected `VoiceAction[]` including `pimote:voice:interrupt` custom-entry data; frames ignored while not active.
- `server/src/voice-orchestrator.test.ts` — lifecycle (`start`/`stop` idempotency), `bindCall` success path (emits `pimote:voice:activate` on the session bus, returns signalling info with token + TURN creds), failure reason codes (`call_bind_failed_session_not_found`, `call_bind_failed_owned`, `call_bind_failed_internal`), force-displacement, `endCall` emits `pimote:voice:deactivate`, is idempotent, and is a no-op for unbound sessions.
- `server/src/extension-ui-bridge.test.ts` — existing file, appended a `voice-mode gating` block: `select` / `confirm` / `input` / `editor` reject with `ui_bridge_disabled_in_voice_mode` while `isVoiceModeActive` returns true; no request events are emitted during rejection; toggling voice-mode between calls re-enables dialogs on the same bridge.
- `client/src/lib/stores/voice-call.svelte.test.ts` — phase state machine: happy path `idle → binding → connecting`, refusal of concurrent calls, server rejection path, `getUserMedia` / signalling failures tear down and reset to idle, `handleServerEvent` (`call_ready` → connected, `call_ended` tears down + records error for `reason=error`, `call_status ringing` nudges binding → connecting, `call_status` never regresses connected), `endCall` idempotency and local-teardown-on-command-failure, `toggleMute` behaviour while active / no-op while idle.

### Behaviors Covered

#### Wire protocol (shared/)

- `CallBindCommand` and `CallEndCommand` carry a correlation `id` and a `sessionId`; bind supports a `force` flag to displace existing voice owners.
- `CallBindResponse` is the success response payload; failed binds use the standard `PimoteResponse` envelope with `error` ∈ `CallBindErrorCode`.
- `call_ready`, `call_ended`, `call_status` events are session-scoped and distinguish reasons (`user_hangup`, `displaced`, `server_ended`, `error`) and statuses (`binding`, `ringing`, `connected`, `ended`).
- `pimote:voice:interrupt` custom entries carry `{ heard_text, kind: 'abort' | 'rollback' }`.

#### Walk-back surgery (packages/voice)

- Always strips trailing synthetic empty-text aborted assistants pi appends to state on abort (idempotent — applies even with no pending rollback).
- On an abort with no audible output AND no captured speak chunks, the aborted turn is omitted entirely from LLM context.
- When the watermark matches the concatenation of speak chunks, all chunks are kept whole.
- Otherwise the first speak chunk that crosses the boundary is truncated to exactly `heardText.slice(spoken.length)`, later blocks are dropped.
- Non-speak blocks (thinking, free text, other tool_use) are kept while `spoken.length < heardText.length`, dropped afterwards.
- Paired `tool_result` blocks in downstream toolResult messages are removed when their `tool_use` is dropped or truncated.
- Reconstructed assistant retains `stopReason: 'aborted'`.
- Only the most recent interrupted turn is reconstructed; earlier interrupts collapse (expected per plan "scope" note; not separately asserted).

#### Voice extension runtime (packages/voice)

- `dormant → activating` on `pimote:voice:activate`; emits `open_speechmux` action with the supplied URL + token.
- Duplicate / out-of-order activates are ignored (no state change, no actions).
- `activating → active` on speechmux opened: sets the default interpreter model on first activation only, then sends the `<voice_call_started/>` sentinel as a user message.
- `activating → dormant` on speechmux failure, emitting a deactivate request back to the orchestrator.
- `active → dormant` on `pimote:voice:deactivate`: closes speechmux and clears the walk-back watermark.
- Speechmux `user` frame → `send_user_message(text)`; `abort` / `rollback` frames → `abort` + watermark set + `pimote:voice:interrupt` custom entry appended with the correct `kind` and `heard_text`.
- Frames received while not `active` are ignored.

#### Voice orchestrator (server)

- `start()` spawns speechmux exactly once; `stop()` is idempotent and clears all active-call bookkeeping.
- `bindCall` emits `pimote:voice:activate` on the target session's EventBus with the internal speechmux LlmBackend WS URL + minted per-call token; returns the signalling URL, token, and TURN credentials to the client.
- `bindCall` on an unknown session fails with `call_bind_failed_session_not_found`.
- `bindCall` on an already-owned session without `force` fails with `call_bind_failed_owned`.
- `bindCall` with `force=true` invokes the displacement seam, then proceeds.
- `bindCall` surfaces mint / internal failures as `call_bind_failed_internal`.
- `endCall` emits `pimote:voice:deactivate` exactly once per active call; repeated calls are no-ops; calls on unbound sessions emit nothing and do not throw.
- `isCallActive` reflects the active-call set.

#### Extension UI bridge (server)

- When `isVoiceModeActive` is true, `select` / `confirm` / `input` / `editor` reject with an error whose message is `ui_bridge_disabled_in_voice_mode` and no WebSocket request event is emitted.
- When `isVoiceModeActive` is false (or undefined), dialog methods behave as before.
- The predicate is consulted on every call, so toggling voice-mode between calls re-enables dialogs on the same bridge instance.

#### Voice call store (client)

- Initial state is `idle` with no session and no error.
- `startCall` sends `call_bind`, transitions `idle → binding → connecting`, creates the peer connection, acquires the microphone, and opens the speechmux signalling WS using the call token returned by the server.
- Attempting a second `startCall` while not idle rejects with `voice_call_already_in_progress`.
- Server `call_bind` error → store returns to `idle` and records the error code in `lastError`.
- `getUserMedia` or signalling failure tears down the peer and returns the store to `idle`.
- `handleServerEvent(call_ready)` for the current session moves `connecting → connected`; for other sessions it is ignored.
- `handleServerEvent(call_ended)` for the current session tears down peer + signalling and returns to `idle`; `reason: 'error'` is recorded as `lastError`.
- `handleServerEvent(call_status: 'ringing')` nudges `binding → connecting`; status events never regress a `connected` phase.
- `endCall` sends `call_end`, tears down locally even if the command fails, and is a no-op from `idle`.
- `toggleMute` flips `micMuted` during an active call; is a no-op when idle.

**Review status:** approved
