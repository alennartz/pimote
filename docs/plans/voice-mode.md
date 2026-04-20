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
  - The `before_provider_request` hook that truncates the last assistant message to the current `heard_text` watermark when active.
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
- `before_provider_request` — if a walk-back watermark is set (see speechmux frame handling below), rewrites the _last assistant message_ in the outgoing payload to `heard_text`. Clears the watermark after applying.
- `tool_call` for `speak` — intercepts the tool call, streams `{type:"token", text}` frames to speechmux, returns a trivial success result so the agent loop advances. Emits `{type:"end"}` when the assistant turn's tool-call batch completes (via `turn_end` or equivalent event).
- Free-text (non-tool) assistant output — explicitly discarded from the audio channel. Scrollback still records it. No audio emission.

Speechmux frame handling (the extension is the harness consumer of speechmux's `LlmBackend` WS protocol):

- Incoming `{type:"user", text}` — calls `session.sendUserMessage(text)` (or `steer` / `followUp` if streaming per the `streamingBehavior` semantics).
- Incoming `{type:"abort"}` — calls `session.abort()`. Sets walk-back watermark to `""` (effectively: truncate last assistant message to empty on next LLM call). Also appends a hidden marker via `appendCustomMessageEntry("pimote:voice:interrupt", { heard_text: "", kind: "abort" }, false)`.
- Incoming `{type:"rollback", heard_text}` — calls `session.abort()`. Sets walk-back watermark to `heard_text`. Appends `appendCustomMessageEntry("pimote:voice:interrupt", { heard_text, kind: "rollback" }, false)`.

Note on the `aborted` flag: pi's `session.abort()` automatically sets `aborted: true` on the in-flight assistant message. The extension does not set this explicitly; it's a pi-level side-effect of calling `abort()`, listed here so readers tracing the brainstorm's named primitives (`abort` + `aborted:true`) see where that flag comes from.

**Walk-back scope in v1.** The `before_provider_request` strategy rewrites _only the last assistant message_ in the outgoing payload. This handles the overwhelming-common case where speechmux emits `rollback{heard_text}` while the interpreter is mid-speaking — i.e. the barged-in text is still the latest assistant entry. **Cross-entry walk-backs** (user interrupts after an entry boundary, e.g. after a tool call and a subsequent new assistant message) are **out of scope for v1**. When we do add cross-entry walk-back later, the correct primitive is `branch(fromId)` — which moves the leaf pointer without recording anything about the abandoned path — _not_ `branchWithSummary`. Summarizing the unheard continuation would reinject it into LLM context, defeating the point of walk-back. Adding `branch()` handling in the extension is an additive change that doesn't disturb the v1 seam.

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
