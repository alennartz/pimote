# DR-011: Interpreter-as-primary with my-pi worker subagents for voice

## Status

Accepted

## Context

Voice-mode needs an LLM behind speechmux's WS `LlmBackend` seam. The same model would have to be simultaneously a great real-time voice conversationalist (low-latency, terse, tool-discipline, barge-in-tolerant) and a great coding agent (deep reasoning, long tool runs, large context). Those profiles conflict — different model sizes, prompting styles, and latency budgets.

Voxcoder addressed this by splitting roles: a cheap fast **interpreter** LLM mediates the conversation, and all real coding work happens in a subordinate **worker** agent. We're porting that pattern to pimote + `my-pi`, but the subagent protocols differ in a way that matters:

- Voxcoder's interpreter watches every SDK event the worker emits — a continuous observation stream.
- `my-pi`'s subagent protocol exposes only `agent_idle`, `agent_message`, and completion notifications to the parent. The parent cannot passively watch the child's internal `tool_call`/`message_update` stream.

## Decision

The voice extension configures the pi session so the **interpreter is the primary agent** and workers are `my-pi` subagents it spawns. Rationale:

- The interpreter runs on `defaultInterpreterModel` (cheap/fast); workers run on `defaultWorkerModel`. The interpreter prompt instructs the model to pass `model: defaultWorkerModel` when spawning subagents.
- Putting the interpreter at the parent gives it the widest available view under `my-pi`. Subagent-side has no visibility at all by default, so the alternative topology would be strictly worse.
- The `my-pi` observation asymmetry is accepted as a known limitation. The interpreter works around it through prompting: explicit small-task decomposition, periodic status polls via `send`, or worker-initiated pushes. Exact cadence is deferred to prompt-engineering, not architecture.

Rejected alternatives:

- **Single-LLM (no interpreter split).** Rejected — can't satisfy both the voice-dialogue and coding-agent profiles simultaneously. Barge-in + silent-minute narration + permission translation would each be separate bolt-ons.
- **Interpreter-as-subagent, worker-as-primary.** Rejected — the subagent side has zero visibility into the parent, so the interpreter would be even more blind than it already is under `my-pi`'s notification-only parent view.

## Consequences

- The interpreter cannot achieve voxcoder-parity observation. Long tool runs risk silent minutes unless the worker is prompted to emit periodic `send` updates or the interpreter is prompted to poll.
- Voxcoder's `<worker_output>` and `<autonomous_decisions>` prompt sections (which assume continuous SDK visibility) had to be dropped or rewritten. `INTERPRETER_PROMPT` is ~80% portable; the streaming-observation parts are not.
- Cross-subagent permission/question propagation is unsolved — v1 sidesteps it by disabling the UI bridge during voice calls (see `ui_bridge_disabled_in_voice_mode`). When v2 wants workers to prompt the user over voice, pi's `tool_call` hook would need to propagate across the subagent boundary, or workers would need to raise permission-style `send`s.
- If `my-pi` later grows a richer subagent-event stream, the interpreter can be upgraded to true passive observation without changing the topology.
