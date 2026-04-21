# @pimote/voice

Voice-mode extension for [pimote](https://github.com/alennartz/pimote). Loaded
into every pimote-hosted pi session (dormant by default) and activated by the
server-side `VoiceOrchestrator` when a client opens a call.

This is an **internal workspace package** — there is no expectation to consume
it standalone. Its surface is documented here so server/client glue code can
be read with a clear picture of the seams.

## What it does

When activated for a session, the extension:

1. Injects a voice-interpreter system prompt (see `RAW_INTERPRETER_PROMPT`
   / `renderInterpreterPrompt(...)` in `interpreter-prompt.ts`) on every
   `before_agent_start` — turns the session's model into a voice-mediator
   that relays user↔worker messages via `speak(...)` and the `my-pi`
   subagent tool. The prompt is templated with the configured worker
   provider/model so the interpreter spawns the right subagent.
2. Registers a `speak(text)` custom tool — the sole way audible output
   reaches speechmux. Free-text (non-tool) assistant output is explicitly
   discarded from the audio channel.
3. Opens a WebSocket to speechmux's `LlmBackend` harness protocol and
   streams each `speak(...)` invocation as a `{type:"token"}` frame,
   flushing `{type:"end"}` at turn end.
4. Handles speechmux `user` / `abort` / `rollback` frames — forwarding user
   turns into `pi.sendUserMessage(text)` and performing walk-back surgery on
   the LLM context the next `context` hook runs (the pure `walkBack(...)`
   function in `walk-back.ts` implements the contract from
   `docs/plans/voice-mode.md`).
5. Emits `pimote:voice:interrupt` custom message entries so the persisted
   session log records when interrupts occurred.

## Public surface

```ts
import {
  createVoiceExtension,
  VOICE_CALL_STARTED_SENTINEL,
  walkBack,
  renderInterpreterPrompt,
  RAW_INTERPRETER_PROMPT,
  type VoiceActivateMessage,
  type VoiceDeactivateMessage,
  type SpeechmuxClient,
  type SpeechmuxClientFactory,
} from '@pimote/voice';

const factory = createVoiceExtension({
  defaultInterpreterModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
  defaultWorkerModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
  // Optional override for tests — production uses the default `ws`-backed factory.
  speechmuxClientFactory: myFakeFactory,
});
```

The returned `ExtensionFactory` is passed through pimote's
`resourceLoaderOptions.extensionFactories` so every session has a voice
instance ready to activate.

### EventBus contract

The extension listens on the session-scoped pi `EventBus` for:

- `pimote:voice:activate` — `VoiceActivateMessage` with `speechmuxWsUrl` and
  `callToken`. The extension opens a speechmux WS, sends a `hello` frame
  carrying `callToken`, and enters `active` state.
- `pimote:voice:deactivate` — tears the WS down and clears the walk-back
  watermark. The extension stays loaded (dormant) for the next call.

Activation / deactivation is driven by `server/src/voice-orchestrator.ts`
in response to `call_bind` / `call_end` WS commands from the client.

## Boundaries

- Does not touch the audio transport — WebRTC signalling lives entirely
  between the pimote client and speechmux. The extension only speaks the
  `LlmBackend` harness protocol to speechmux.
- Does not own call lifecycle — `VoiceOrchestrator` mints per-call tokens,
  displaces existing owners, and broadcasts `call_ended` to clients.
- Does not persist scrollback — v1 accepts pi's existing behaviour that
  interrupted turns leave no assistant entry in the session JSONL; the
  `pimote:voice:interrupt` custom entry is the marker that _something_ was
  said and cut off.
