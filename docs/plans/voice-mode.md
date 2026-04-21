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

## External dependencies (not planned here)

The following speechmux-repo changes are prerequisite for end-to-end smoke but are **out of scope for this pimote impl plan** (they live in the speechmux repo):

- Lift the WS `LlmBackend` listener out of the per-call loop so it binds at startup and survives across calls.
- Replace the single shared env token on `/signal` with per-call auth tokens (minted by pimote's orchestrator, echoed by the client in `hello.token`, validated by speechmux).

Their status blocks only **Step 14 (end-to-end smoke)**; all earlier steps use the injected seams (`startSpeechmux`, `mintCallToken`, `SpeechmuxClientFactory`) so tests and partial runtime can be completed without them.

## Steps

**Pre-implementation commit:** `5fe18eedd69c5c69edab4dccc81fb25857735171`

Commits use conventional `impl:` / `fix:` prefixes with `voice-mode` scope where possible. Each step's **Verify** names the concrete test file(s) or behavior to run; the test-review commit (`334d947`) is the fixed baseline — no test edits are permitted during impl.

### Step 1: Finalize `VoiceOrchestrator.bindCall` ownership semantics

`server/src/voice-orchestrator.ts` currently emits `pimote:voice:activate` on every successful bind, but the plan and tests expect the orchestrator to call `displaceOwner` only when another voice call already owns the session and `force=true`. Audit `bindCall` against `server/src/voice-orchestrator.test.ts`:

- Ensure `isOwnedByVoiceCall` + `force` gating matches the `call_bind_failed_owned` / force-displacement test cases.
- Ensure mint failures produce `call_bind_failed_internal` even when the bus lookup would have also failed.
- Ensure `endCall` is idempotent and a no-op on unbound sessions, emitting exactly one `pimote:voice:deactivate` on the first call.
- Confirm `start` spawns speechmux once and `stop` is idempotent + clears `activeCalls`.

No new architectural decisions — this is strictly matching the test suite.

**Verify:** `npm run test --workspace server -- voice-orchestrator` passes all cases.
**Status:** done

### Step 2: INTERPRETER_PROMPT module

Create `packages/voice/src/interpreter-prompt.ts` exporting `INTERPRETER_PROMPT: string` (and re-export from `packages/voice/src/index.ts`). Adapt voxcoder's interpreter prompt with multimodal placeholders removed. Must instruct the model to:

1. When it sees the `<voice_call_started/>` sentinel as the first user message, greet the user via `speak(...)` and await real user input.
2. Use the `speak(text)` tool for all audible output; free-text output is discarded from audio.
3. When dispatching work to `my-pi` subagents, pass `model: defaultWorkerModel` (provider/modelId injected via prompt template substitution at factory time).

The factory in Step 3 substitutes `{{workerProvider}}` / `{{workerModel}}` placeholders at build time so the prompt is a static string by the time it's registered.

**Verify:** File exists, exports a non-empty string, referenced from `index.ts`. `npm run build --workspace @pimote/voice` succeeds.
**Status:** done

### Step 3: Default `SpeechmuxClient` factory

In `packages/voice/src/speechmux-client.ts` (or a new `speechmux-ws-client.ts`), add `createDefaultSpeechmuxClientFactory(): SpeechmuxClientFactory` using the `ws` package. The client:

- Opens `new WebSocket(wsUrl)` and sends `{ type: 'hello', token: callToken }` on open (matching the speechmux LlmBackend harness framing from `speechmux/docs/llm-ws-protocol.md`).
- Parses incoming JSON messages into `IncomingFrame` (`user` / `abort` / `rollback`) and dispatches to listeners.
- `send(frame)` serializes `OutgoingFrame` and writes to the socket; throws if not open.
- `close()` is idempotent.

Add `ws` as a runtime dependency of `@pimote/voice` via `npm install ws --workspace @pimote/voice` (+ `@types/ws` as dev dep).

**Verify:** Compiles. No new tests required (tests use the injected fake factory). Referenced as the default in `createVoiceExtension` (Step 4).
**Status:** done

### Step 4: Implement `createVoiceExtension`

Replace the stub in `packages/voice/src/index.ts` with a real implementation that wires the pure reducers in `extension-runtime.ts` to the pi `ExtensionAPI`. Structure it as an `ExtensionFactory` that, on invocation with `pi: ExtensionAPI`, does:

1. Hold a single `VoiceRuntimeState` (via `initialRuntimeState()`) and a single `capturedStreamingMessage: AgentMessage | null`, a `walkBackInput: { heardText: string } | null`, and a `speechmuxClient: SpeechmuxClient | null` — all per-extension-instance.
2. Implement `executeActions(actions: VoiceAction[])` that maps each action to an `ExtensionAPI` call or internal state mutation:
   - `open_speechmux` → `speechmuxClient = await speechmuxClientFactory({ wsUrl, callToken })`; subscribe to frames → `reduceSpeechmuxFrame`; on open-resolve execute `reduceSpeechmuxOpened`; on error execute `reduceSpeechmuxFailed`.
   - `close_speechmux` → `speechmuxClient?.close(); speechmuxClient = null`.
   - `send_user_message` → `pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined)`.
   - `abort` → `ctx.abort()` on whichever `ExtensionContext` is available (captured from the most recent hook invocation or held per-session by the extension instance).
   - `set_walkback_watermark` → store `walkBackInput = { heardText }`.
   - `clear_walkback_watermark` → `walkBackInput = null`; `capturedStreamingMessage = null`.
   - `append_custom_entry` → `pi.appendEntry(customType, data)`.
   - `set_model` → look up the model by `{ provider, modelId }` and call `pi.setModel(model)`. If no match, log a warning and skip.
   - `emit_deactivate_request` → publish `pimote:voice:deactivate` on `pi.events` so the orchestrator tears down server-side bookkeeping.
   - `stream_speechmux_token` → `speechmuxClient?.send({ type: 'token', text })`.
   - `emit_speechmux_end` → `speechmuxClient?.send({ type: 'end' })`.
   - `return_speak_tool_result` → return a trivial success from the `tool_call` hook (see 6 below).
3. Register EventBus listeners on `pi.events` for `pimote:voice:activate` → `reduceActivate`, `pimote:voice:deactivate` → `reduceDeactivate`.
4. Register the `speak` custom tool via `pi.registerTool({ name: 'speak', params: { text: string }, ... })`. The tool's handler is a no-op that returns success; audible streaming happens via the `tool_call` hook in (6) so we intercept the args before execution. (If the tool handler is unreachable while `state === active` because `tool_call` returns `{ action: 'handled' }`, that's intentional.)
5. Register `before_agent_start` — while `active`, prepend `INTERPRETER_PROMPT` to `event.systemPrompt`.
6. Register `tool_call` — if `toolName === 'speak'` and runtime is `active`, run `reduceSpeakToolCall(state, input)`; execute actions; return `{ action: 'handled', result: { success: true } }` (or the pi-SDK equivalent).
7. Register `turn_end` — run `reduceTurnEnd(state)`; execute actions.
8. Register `message_update` — overwrite `capturedStreamingMessage` with a deep-enough copy of `event.message` (content blocks) so we have the in-flight assistant turn if it gets aborted.
9. Register `context` — if runtime is `active` OR `walkBackInput !== null`, run the pure `walkBack({ messages: event.messages, heardText: walkBackInput?.heardText ?? null, captured: capturedStreamingMessage })`; assign back to `event.messages`. Then clear `walkBackInput` and `capturedStreamingMessage` per the contract.

Abort mechanism (resolved): `ExtensionContext.abort()` is exposed by pi's extension system — see `@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:198` (the `ExtensionContext` interface declares `abort(): void` alongside `isIdle()`, `signal`, and friends). It's also mirrored on `ExtensionContextActions` at the same file line ~1013. The `abort` `VoiceAction` must be executed from within a hook context (or any other place where the extension holds an `ExtensionContext`), not from the bare runtime reducer. The runtime reducer emits the `VoiceAction`; the action executor (wired in Step 4) invokes `ctx.abort()`.

The default `speechmuxClientFactory` is the one from Step 3; `opts.speechmuxClientFactory` overrides it for tests.

**Verify:** `npm run test --workspace @pimote/voice` — the existing reducer tests still pass (unchanged) and the factory no longer throws when invoked. Add a minimal smoke assertion in a new `packages/voice/src/index.test.ts` that `createVoiceExtension({...})` returns a function that, when called with an `ExtensionAPI` mock, registers at least the `speak` tool and `before_agent_start` / `context` / `tool_call` / `turn_end` / `message_update` listeners.
**Status:** done

**Commit:** `impl(voice): voice extension runtime — interpreter prompt, speechmux client, factory wiring`

### Step 5: Thread voice extension factory into `openSession`

In `server/src/session-manager.ts` `openSession`:

- Import `createVoiceExtension` from `@pimote/voice`.
- Build a single `voiceExtension` factory at `PimoteSessionManager` construction time (or on each `openSession` call — either is fine since it's cheap), using `config.defaultInterpreterModel` (fallback: `{ provider: config.defaultProvider!, modelId: config.defaultModel! }`) and `config.defaultWorkerModel` (same fallback). Skip construction if `defaultProvider`/`defaultModel` are missing AND no `defaultInterpreterModel` is configured — log a warning and do not register the extension, so existing non-voice deployments keep working.
- In the `factory` closure inside `openSession`, pass `extensionFactories: [voiceExtension]` into `resourceLoaderOptions` (alongside the existing `eventBus`).

**Verify:** `npm run test --workspace server` still passes (session-manager tests); `npm run build` succeeds. A temporary `console.log` in `createVoiceExtension` confirms it's invoked once per session on manual smoke.
**Status:** done

### Step 6: Instantiate `VoiceOrchestrator` in server boot

In `server/src/index.ts` (and/or `server.ts`):

1. Import `VoiceOrchestrator` from `./voice-orchestrator.js`.
2. Build a `busResolver: VoiceSessionBusResolver` backed by the `PimoteSessionManager` — it needs a new `getSlot(sessionId): ManagedSlot | null` accessor on `PimoteSessionManager` if one does not already exist; `getEventBus(sessionId)` returns `slot.eventBusRef.current`.
3. Provide real implementations of the seams:
   - `startSpeechmux` — spawn `config.voice?.speechmuxBinary` as a child process with stdio piped; resolve once it logs its WS ready marker (or after a short timeout — TBD with speechmux). If `config.voice?.speechmuxBinary` is unset, `start()` is a no-op and the orchestrator stays disabled; `bindCall` will fail with `call_bind_failed_internal`.
   - `stopSpeechmux` — `SIGTERM` the child, `SIGKILL` on timeout. Idempotent.
   - `mintCallToken(sessionId)` — v1: generate a random token (`crypto.randomUUID()`), POST it to speechmux's admin endpoint (contract owned by speechmux; see External dependencies). Also fetch/derive TURN creds (speechmux's existing DR-013 flow). Returns `{ token, turn, webrtcSignalUrl: config.voice!.speechmuxSignalUrl! }`.
   - `displaceOwner(sessionId, newOwner)` — wraps the existing ws-handler displacement path: look up the current owner via the `clientRegistry`, call its `sendDisplacedEvent(sessionId)`. Exposed from ws-handler as a static or via a small `SessionDisplacer` helper to avoid a circular dep.
   - `isOwnedByVoiceCall(sessionId)` — returns `orchestrator.isCallActive(sessionId)`.
4. `await orchestrator.start()` after `server.start(port)` (or on first use — lazy is also fine, but eager start simplifies readiness).
5. On shutdown, `await orchestrator.stop()` before `server.close()`.
6. Pass the orchestrator into `createServer(...)` and then into `WsHandler` (constructor arg).

**Verify:** Server starts and logs orchestrator ready state. Existing tests pass. Manual curl/ws smoke of unrelated commands still works.
**Status:** done

### Step 7: Wire `call_bind` / `call_end` into `WsHandler`

In `server/src/ws-handler.ts`:

1. Add `private readonly voiceOrchestrator: VoiceOrchestrator` to the constructor signature.
2. Add `case 'call_bind':` to the command switch. Body:
   - Resolve the `ManagedSlot` for `command.sessionId`; if absent, `sendResponse(id, false, undefined, 'call_bind_failed_session_not_found')`.
   - Build a `ClientConnection` from this handler (existing pattern in `claimSession`).
   - `try { const data = await voiceOrchestrator.bindCall({ sessionId, clientConnection, force: command.force ?? false }); sendResponse(id, true, data); } catch (err) { if (err instanceof CallBindError) sendResponse(id, false, undefined, err.code); else sendResponse(id, false, undefined, 'call_bind_failed_internal'); }`.
   - On success, emit a `call_status` event (`status: 'binding'`) to this client.
3. Add `case 'call_end':` — `await voiceOrchestrator.endCall({ sessionId: command.sessionId, reason: 'user_hangup' })`; `sendResponse(id, true)`; emit `call_ended { reason: 'user_hangup' }` to the client.
4. When this handler sends a `session_closed { reason: 'displaced' }` to an old owner whose session has an active call, also emit `call_ended { reason: 'displaced' }` to the old owner (so their `VoiceCallStore` tears down).
5. In `claimSession`, when creating the `ExtensionUIBridge`, pass `{ isVoiceModeActive: () => voiceOrchestrator.isCallActive(sessionId) }` as the options arg. Do the same in the `handleSessionReset` rebind path.
6. Wire an `orchestrator → ws-handler` path so `call_ready` can be broadcast when speechmux reports the WebRTC peer connected. v1 shortcut: the orchestrator doesn't know about WebRTC readiness, so the client's own WebRTC connection state drives `connected` phase locally; the server emits `call_ready` from the orchestrator once speechmux notifies via its admin/event surface (deferred to Step 14 smoke — for v1, the client may transition to `connected` on its WebRTC `iceConnectionState === 'connected'` and fire `call_ready` is merely advisory). Surface this decision to the user if the shortcut is not acceptable.

**Verify:** `npm run test --workspace server -- ws-handler extension-ui-bridge` passes. The existing `extension-ui-bridge` voice-mode-gating suite passes via the real predicate wiring.
**Status:** done

**Commit:** `impl(server): voice orchestrator + ws-handler routing + UI-bridge gating`

### Step 8: Client — real `VoiceCallSeams`

In `client/src/lib/stores/voice-call.svelte.ts`, add a `createBrowserVoiceCallSeams(connection: ConnectionStore)` factory (separate file `voice-call-seams.ts` is fine if it keeps the store testable). Implementations:

- `sendCommand` — forwards to the existing pimote WS connection store's request/response helper.
- `createPeerConnection(turn)` — `new RTCPeerConnection({ iceServers: [{ urls: turn.urls, username: turn.username, credential: turn.credential }] })`; wrap it to conform to `VoicePeerConnection`.
- `getUserMedia()` — `navigator.mediaDevices.getUserMedia({ audio: true })`; returns `{ stream, tracks: stream.getAudioTracks() }`.
- `openSignaling(url, callToken)` — `new WebSocket(url)` + `hello.token` frame on open; wrap to conform to `VoiceSignalingSocket`; route offer/answer/ice through the `RTCPeerConnection` (full `hello → session → offer/answer → ice → bye` handshake per `speechmux/src/webrtc_transport/signaling.rs`). Expose `opened` as a `Promise<void>` that resolves on `ws.onopen`.

The store itself needs a small extension: on `connected → disconnect`, also flip local WebRTC `iceConnectionState === 'connected'` into a synthetic `call_ready` self-event so the `connecting → connected` transition happens without server round-trip (matches Step 7's shortcut).

**Verify:** `npm run test --workspace client -- voice-call` still passes (seams are constructor-injected, so real seams don't affect reducer tests). Manual mic-permission prompt fires on first call.
**Status:** done

### Step 9: Route voice events into `VoiceCallStore`

In `client/src/lib/stores/connection.svelte.ts` (or wherever incoming server events fan out):

- Instantiate a single `voiceCallStore = new VoiceCallStore(createBrowserVoiceCallSeams(...))` and export it (e.g. via a `voice-call-store.ts` wrapper module using Svelte context).
- In the event dispatcher, route `call_bind_response` (if exposed as event) / `call_ready` / `call_ended` / `call_status` to `voiceCallStore.handleServerEvent(event)`.
- On `session_closed { reason: 'displaced' }`, if `voiceCallStore.state.sessionId === event.sessionId`, synthesize a `call_ended { reason: 'displaced' }` for local teardown.

**Verify:** Routing works in the browser; `voice-call.svelte.test.ts` unaffected. Manual: opening devtools and inspecting the store shows phase transitions on a fake server event.
**Status:** done

### Step 10: Client UI — per-session Call button

Add a Call button to the per-session header (likely `client/src/lib/components/StatusBar.svelte` or `ActiveSessionBar.svelte` — confirm via layout inspection). Click → `voiceCallStore.startCall(sessionId)`. Disabled while `voiceCallStore.state.phase !== 'idle'` OR `voiceCallStore.state.sessionId !== null && voiceCallStore.state.sessionId !== sessionId` (a call on another session is active).

Use shadcn-svelte's existing `Button` primitive; icon `Phone` from `lucide-svelte`.

**Verify:** Button renders, click transitions store to `binding` (confirmed via devtools inspection or adding a `client/src/lib/components/CallButton.svelte.test.ts` render check).
**Status:** done

### Step 11: Client UI — in-call banner with mute + hangup

Add `client/src/lib/components/CallBanner.svelte`:

- Renders when `voiceCallStore.state.phase !== 'idle'`.
- Shows current phase (binding / connecting / connected / ending).
- Mute button → `voiceCallStore.toggleMute()`.
- Hangup button → `voiceCallStore.endCall()`.
- Displays `state.lastError` when set.

Mount globally in `client/src/routes/+layout.svelte` above the main content, so it survives session switches.

Wire the mute toggle through the peer connection: extend `VoicePeerConnection` seam with `setMicrophoneEnabled(enabled: boolean)`, called from the store on `toggleMute` (store already flips `micMuted`; the real seam must apply the change to the RTC audio track via `track.enabled = enabled`).

**Verify:** Manual — start a call, banner appears, mute button toggles the local audio track's `enabled` state (verified via devtools or a speechmux-side round-trip in Step 14).
**Status:** done

**Commit:** `impl(client): voice call store seams + UI (Call button, in-call banner)`

### Step 12: Wire `call_ended` broadcasts from displacement paths

Revisit `server/src/ws-handler.ts` displacement and session-close paths: any path that tears down ownership of a session currently bound to a voice call must call `voiceOrchestrator.endCall({ sessionId, reason: 'displaced' | 'server_ended' })` before the session is removed, so the orchestrator's per-session bookkeeping and the extension's deactivate reducer fire.

Also: when `PimoteSessionManager` reaps an idle session, call `voiceOrchestrator.endCall(..., reason: 'server_ended')` first.

**Verify:** `npm run test --workspace server` passes. Manual: force-close a session with an active call → the client receives `call_ended { reason: 'server_ended' }` and the store returns to `idle`.
**Status:** done

### Step 13: Config + docs polish

- Document the new `voice` / `defaultInterpreterModel` / `defaultWorkerModel` config fields in `README.md` (or equivalent pimote user docs).
- Add a sample `voice` block to the example config in the docs, calling out that `speechmuxBinary` / `speechmuxSignalUrl` / `speechmuxLlmWsUrl` are required to enable voice and that absence disables the feature gracefully.
- Add a `packages/voice/README.md` describing the extension's public surface.

**Verify:** Docs render; `npm run build` across workspaces succeeds.
**Status:** done

**Commit:** `impl(voice): displacement tear-down + docs`

### Step 14: End-to-end smoke (blocked on speechmux external work)

With the speechmux-repo changes landed (startup-time LlmBackend listener + per-call tokens on `/signal`):

1. Start pimote server with `voice.*` config pointing at a local speechmux binary.
2. Open a session in the PWA; click Call.
3. Confirm: `call_bind` round-trips with TURN creds; getUserMedia prompts; `/signal` WS opens; WebRTC peer connects (`iceConnectionState === 'connected'`); banner flips to `connected`.
4. Speak; speechmux transcribes and sends `{type:'user', text}` on LlmBackend WS; interpreter responds with `speak(...)` tool calls; text streams back as audio.
5. Barge in: confirm speechmux sends `{type:'rollback', heard_text}`; confirm the next LLM turn's `context.messages` has been walk-back-surgeried (observable via an instrumentation log or by inspecting the persisted session's `pimote:voice:interrupt` entries).
6. Hang up; confirm `call_ended`; confirm the UI bridge is re-enabled (run a pi extension dialog command and observe it resolves normally).
7. Displace: start a second call on the same session with `force: true` from a different browser — confirm the first client gets `call_ended { reason: 'displaced' }` and the extension's deactivate reducer ran (speechmux client closed).

**Verify:** All seven steps above succeed by direct observation. File a manual-test checklist entry in `docs/manual-tests/voice-mode.md` capturing the run (follow existing manual-test conventions if present).
**Status:** blocked — waiting on speechmux-repo LlmBackend listener refactor + per-call auth tokens on `/signal`

**Commit:** `impl(voice): end-to-end smoke documented` (after the run succeeds)
