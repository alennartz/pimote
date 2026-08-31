# Plan: Native `!` Bash Commands

## Context

Pimote should mirror Pi TUI’s leading `!` command: execute shell text directly through the live embedded `AgentSession`, with `!!` excluding the result from LLM context. The agreed behavior and scope are recorded in [`docs/brainstorms/bang-bash-command.md`](../brainstorms/bang-bash-command.md).

## Architecture

### Impacted Modules

- **Protocol (`shared/src/**`)\*\* — add session-scoped bash and bash-abort commands, a wire result shape, and a live output event. The protocol remains SDK-free; the Android hand-mirror is not expanded because Android does not consume the web composer/session-control subset.
- **Server / command routing (`server/src/ws-handler.ts`)** — route `bash` and `abort_bash` through the existing session command handler. Invoke Pi’s native user-bash interception and `AgentSession.executeBash()`/`recordBashResult()` APIs, passing the WebSocket request ID into Pi’s bash event ID. Return the final result to the initiating owner connection and reject a second command while `session.isBashRunning`.
- **Server / SDK event boundary (`server/src/event-buffer.ts`)** — map the real SDK `bash_execution_update` event into the new wire event. Forward chunks live to the existing owning connection and keep them out of replay, matching the current treatment of streaming deltas. Do not invent an SDK shadow type.
- **Server / message mapping (`server/src/message-mapper.ts`)** — retain the existing `bashExecution` role mapping and include native result metadata (`command`, `exitCode`, `cancelled`, `truncated`, optional `fullOutputPath`, and context-exclusion state where available) so normal `!` results rendered after context resync retain their status. Context-only resync remains unchanged for `!!`: excluded entries may be absent after reconnect.
- **Web Client / connection and session reduction (`client/src/lib/stores/connection.svelte.ts`, `client/src/lib/stores/session-registry.svelte.ts`)** — correlate command IDs, hold transient per-session bash executions, append output deltas, finalize them from the command response, and clear/reconcile transient state during resync. Finalized live executions become ordinary `bashExecution` messages; `!!` can subsequently disappear when the server sends the existing context view.
- **Web Client / composer (`client/src/lib/components/InputBar.svelte`)** — parse leading `!`/`!!` before slash-command, streaming-steer, and normal-prompt handling. Start bash even while the model streams; do not send it as a steer. Supply a caller-owned request ID so update events can be correlated.
- **Web Client / conversation rendering (`client/src/lib/components/MessageList.svelte`, new `BashExecution.svelte`, and `Message.svelte`)** — render pending and finalized bash entries with Pi-like `$ command`/output/status treatment, a distinct bash-mode color, dim styling for excluded commands, collapsed long-output preview, and an item-level Cancel action. Keep bash visually separate from assistant/tool messages.

### New Modules

- **`client/src/lib/components/BashExecution.svelte`** — deep presentation component for one bash execution. It owns output preview/truncation display, running/completed/cancelled/nonzero status, normal-vs-excluded color treatment, and the cancel callback; callers provide state and do not reproduce bash rendering rules.

### Interfaces

#### Protocol → Server: bash commands

```ts
interface BashCommand extends CommandBase {
  type: 'bash';
  command: string;
  excludeFromContext?: boolean; // true for !!
}

interface AbortBashCommand extends CommandBase {
  type: 'abort_bash';
}

interface BashResult {
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}
```

`bash` is session-scoped and uses its command `id` as the correlation ID. The server calls extension `emitUserBash` first, honoring an extension-provided complete result or custom operations; otherwise it calls `session.executeBash(command, undefined, { id, excludeFromContext, operations })`. The execution path must record the result in Pi session history. `abort_bash` calls `session.abortBash()` and responds after issuing the cancellation request.

A second `bash` received while `session.isBashRunning` fails with a stable conflict error and does not start another process. An empty command is not a bash command; the client leaves it on the normal text path, matching Pi’s submit behavior.

#### SDK event boundary → Protocol

```ts
interface BashExecutionUpdateEvent extends SessionEventBase {
  type: 'bash_execution_update';
  id?: string;
  delta: string;
}
```

The event mapper consumes the real SDK event and forwards its output delta live to the session’s existing owner connection. If the SDK omits its optional ID, the client applies the update to the sole running bash for that session; the server rejects concurrent bash commands, so this fallback is unambiguous. Pimote’s existing session ownership model displaces competing viewers, so bash output is intentionally not broadcast to separate clients. The event is never placed in the replay ring; the final response and subsequent context synchronization are the durable boundaries. The server must not synthesize `agent_start`, `message_start`, or `message_end` for bash.

#### Server response → Client reducer

The successful `bash` response carries `{ result: BashResult }`. The client associates it with the caller-owned command ID, stops the transient execution, and appends a `PimoteAgentMessage` with `role: 'bashExecution'` plus the command/result metadata. Output deltas may arrive before or after the response and are keyed by the same ID; a response with no prior delta still renders correctly from `result.output`. A later full resync replaces the entire message list and clears transient executions rather than appending, so live completion cannot duplicate a persisted result; context-only resync may omit `!!` by design.

#### Client session state → renderer

```ts
interface BashExecutionState {
  id: string;
  command: string;
  excludeFromContext: boolean;
  output: string;
  status: 'running' | 'complete' | 'cancelled' | 'error';
  result?: BashResult;
}
```

`SessionRegistry` owns `bashExecutions: Record<string, BashExecutionState>` per session and exposes reducer operations for start, update, complete, and clear. `MessageList` includes running entries in display order alongside persisted messages; completed entries are moved into the normal message list. If an update has no ID, the reducer applies it to the sole running bash; if there is no unique candidate, it drops the update. A full resync replaces the message list and clears transient executions, so an excluded `!!` result may disappear by design.

`BashExecution.svelte` accepts a `BashExecutionState`/final message, renders `$ <command>`, sanitized output, a bounded collapsed preview, exit/cancel/truncation status, and `onCancel`. Normal commands use the bash-mode color; excluded commands use a dim variant. `onCancel` sends `abort_bash` for the relevant session; it is independent of the model Abort/Escape control.

#### Input parsing

The composer recognizes a trimmed leading `!!` before `!`, strips the prefix, trims the command boundary, and sends the remainder unchanged. This branch runs before the existing streaming-steer branch, so a bang command executes concurrently with a model stream instead of entering the steering queue. Slash commands, ordinary prompts, staged images, and autocomplete behavior remain otherwise unchanged.

### Technology Choices

No new dependency or runtime technology is introduced. The design uses the already embedded Pi SDK (`AgentSession.executeBash`, `recordBashResult`, `abortBash`, and typed `bash_execution_update` events), the existing WebSocket protocol, Svelte session reduction, and the existing client styling system. A separate server `child_process` implementation and Pi RPC subprocess were rejected because they would bypass the accepted SDK-embedding boundary, extension interception, native history/context semantics, and cancellation.
