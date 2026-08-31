# Plan: Native `!` Bash Commands

## Context

Pimote should mirror Pi TUI’s leading `!` command: execute shell text directly through the live embedded `AgentSession`, with `!!` excluding the result from LLM context. The agreed behavior and scope are recorded in [`docs/brainstorms/bang-bash-command.md`](../brainstorms/bang-bash-command.md).

## Architecture

### Impacted Modules

- **Protocol (`shared/src/**`)\*\* — add session-scoped bash and bash-abort commands, a wire result shape, and a live output event. The protocol remains SDK-free; the Android hand-mirror is not expanded because Android does not consume the web composer/session-control subset.
- **Server / command routing (`server/src/ws-handler.ts`)** — route `bash` and `abort_bash` through the existing session command handler. Invoke Pi’s native user-bash interception and `AgentSession.executeBash()`/`recordBashResult()` APIs, passing the WebSocket request ID into Pi’s bash event ID. Return the final result to the initiating owner connection and reject a second command while `session.isBashRunning`.
- **Server / SDK event boundary (`server/src/event-buffer.ts`)** — map the real SDK `bash_execution_update` event into the new wire event. Forward chunks live to the existing owning connection and keep them out of replay, matching the current treatment of streaming deltas. Do not invent an SDK shadow type.
- **Server / message mapping (`server/src/message-mapper.ts`)** — retain the existing `bashExecution` role mapping and include native result metadata (`command`, `exitCode`, `cancelled`, `truncated`, optional `fullOutputPath`, and context-exclusion state where available) so normal `!` results rendered after context resync retain their status. Context-only resync remains unchanged for `!!`: excluded entries may be absent after reconnect.
- **Web Client / connection and session reduction (`client/src/lib/stores/connection.svelte.ts`, `client/src/lib/stores/session-registry.svelte.ts`)** — correlate command IDs, hold transient per-session bash executions, append output deltas, promote successful responses into ordinary `bashExecution` messages, retain dispatch failures as visible non-context errors, and clear transient state during resync. Finalized live executions become ordinary messages; `!!` can subsequently disappear when the server sends the existing context view.
- **Web Client / composer (`client/src/lib/components/InputBar.svelte`)** — parse leading `!`/`!!` before slash-command, streaming-steer, and normal-prompt handling. Start bash even while the model streams; do not send it as a steer. Supply a caller-owned request ID so update events can be correlated.
- **Web Client / conversation rendering (`client/src/lib/components/MessageList.svelte`, new `BashExecution.svelte`, and `Message.svelte`)** — render pending and finalized bash entries with Pi-like `$ command`/output/status treatment, a distinct bash-mode color, dim styling for excluded commands, collapsed long-output preview, and an item-level Cancel action. Keep bash visually separate from assistant/tool messages.

### New Modules

- **`client/src/lib/components/BashExecution.svelte`** — deep presentation component for one bash execution. It owns output preview/truncation display, running/completed/cancelled/nonzero/dispatch-error status, normal-vs-excluded color treatment, and the cancel callback; callers provide state and do not reproduce bash rendering rules.

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

A second `bash` received while `session.isBashRunning` fails with the stable `bash_already_running` error and does not start another process. An empty command is not a bash command; the client leaves it on the normal text path, matching Pi’s submit behavior.

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

The successful `bash` response carries `{ result: BashResult }`. The client associates it with the caller-owned command ID, appends a `PimoteAgentMessage` with `role: 'bashExecution'` plus the command/result metadata, and removes the transient execution. The final response is canonical: the server emits SDK output updates before its awaited response on the same WebSocket, so a later update for that completed ID is dropped rather than resurrecting transient state or duplicating output. A response with no prior delta still renders correctly from `result.output`. An unsuccessful response or rejected dispatch retains the transient item in `error` state with its error text; it is visible but never becomes context. A later full resync replaces the entire message list and clears transient executions rather than appending, so live completion cannot duplicate a persisted result; context-only resync may omit `!!` by design.

#### Client session state → renderer

```ts
interface BashExecutionState {
  id: string;
  command: string;
  excludeFromContext: boolean;
  output: string;
  status: 'running' | 'complete' | 'cancelled' | 'error';
  result?: BashResult;
  error?: string; // present only for a failed dispatch
}
```

`SessionRegistry` owns `bashExecutions: Record<string, BashExecutionState>` per session and exposes reducer operations for start, update, complete, fail, and clear. `MessageList` includes running and error entries in display order alongside persisted messages; completion promotes an entry then removes its transient record. If an update has no ID, the reducer applies it to the sole running bash; if there is no unique candidate, or its ID is already complete, it drops the update. A full resync replaces the message list and clears transient executions, so an excluded `!!` result may disappear by design.

`BashExecution.svelte` accepts a `BashExecutionState`/final message, renders `$ <command>`, sanitized output, a bounded collapsed preview, exit/cancel/truncation/dispatch-error status, and `onCancel`. Normal commands use the bash-mode color; excluded commands use a dim variant. `onCancel` sends `abort_bash` for the relevant session; it is independent of the model Abort/Escape control.

#### Input parsing

The composer recognizes a trimmed leading `!!` before `!`, strips the prefix, trims the command boundary, and sends the remainder unchanged. This branch runs before the existing streaming-steer branch, so a bang command executes concurrently with a model stream instead of entering the steering queue. Slash commands, ordinary prompts, staged images, and autocomplete behavior remain otherwise unchanged.

### Technology Choices

No new dependency or runtime technology is introduced. The design uses the already embedded Pi SDK (`AgentSession.executeBash`, `recordBashResult`, `abortBash`, and typed `bash_execution_update` events), the existing WebSocket protocol, Svelte session reduction, and the existing client styling system. A separate server `child_process` implementation and Pi RPC subprocess were rejected because they would bypass the accepted SDK-embedding boundary, extension interception, native history/context semantics, and cancellation.

## Tests

**Pre-test-write commit:** `683ec2607d742b3781b228157778f2d16859c066`

### Interface Files

- `shared/src/protocol.ts` — bash/abort command DTOs, `BashResult` response data, bash update event, and native bash message metadata.
- `server/src/event-buffer.ts` — accepts the SDK-owned `bash_execution_update` event without a Pimote shadow type.
- `client/src/lib/bash-command.ts` — composer parsing seam for leading `!` and `!!` commands.
- `client/src/lib/stores/session-registry.svelte.ts` — `BashExecutionState`, transient state field, event boundary, and reducer operation contracts.
- `client/src/lib/components/BashExecution.svelte` — dedicated bash presentation component props contract.

### Test Files

- `server/src/event-buffer.test.ts` — live mapping and non-replay behavior for identified and unidentified SDK bash output updates.
- `server/src/message-mapper.test.ts` — preservation of native bash command/result status metadata, including cancellation, truncation, full-output paths, and context exclusion.
- `server/src/ws-handler.test.ts` — native execution while model streaming, extension interception/result/operations handling, `!!` recording, concurrent-command conflict, and bash-specific cancellation contracts.
- `client/src/lib/bash-command.test.ts` — leading bang parsing, whitespace boundaries, ordinary prompt pass-through, and empty-command behavior.
- `client/src/lib/stores/session-registry.test.ts` — transient lifecycle, output-correlation fallback, canonical completion/removal, dispatch errors, resync clearing, and live event reduction.
- `client/src/lib/components/InputBar.bash.test.ts` — mounted composer behavior before streaming steer handling, caller-owned IDs, and unsuccessful/rejected dispatch handling.
- `client/src/lib/components/MessageList.bash.test.ts` — mounted transient/error/final bash display and independent cancellation wiring.
- `client/src/lib/components/BashExecution.test.ts` — mounted renderer command/status/preview/cancel/exclusion/sanitization presentation contract.

### Behaviors Covered

#### Protocol and server event boundary

- A native `bash_execution_update` is mapped to a session-scoped wire event with cursor, optional command ID, and output delta.
- Bash output deltas are forwarded live but omitted from the replay ring; missing SDK IDs remain representable for the sole-running-command fallback.
- Native bash result metadata survives message mapping, including nonzero exit status, cancellation, truncation, full-output path, and `!!` context exclusion.
- A `bash` command requires a session scope, runs while a model stream is active, invokes extension user-bash interception, passes caller correlation/exclusion/custom operations through the SDK path, returns the native `BashResult`, and records only extension-handled results.
- A second `bash` while `isBashRunning` is rejected with `bash_already_running` and does not start another process or extension handler.
- `abort_bash` invokes `abortBash` without invoking the model `abort` path.

#### Composer parsing and session reduction

- Leading `!` starts a context-visible command; leading `!!` starts a context-excluded command.
- Parser trimming removes only the bang and command boundary; ordinary prompts and bare bang prefixes stay on the normal path.
- A session can track a caller-owned bash execution as running, append identified deltas, and apply an unidentified delta only when one running candidate exists.
- Completion carries native status metadata, promotes the live execution to a `bashExecution` message, removes its transient state, and drops any later duplicate update for that ID.
- An unsuccessful response or rejected dispatch retains a visible `error`-state transient without adding context.
- Full resync clears all transient executions while preserving only server-supplied messages.
- The mounted composer checks bang commands before streaming steer logic, supplies request IDs, preserves `!!` exclusion, and leaves bare bangs on the ordinary prompt path; message display owns independent bash cancellation.

#### Bash presentation

- Bash entries render with a distinct shell prompt/mode, running/completed/cancelled/nonzero/truncated/dispatch-error status, bounded collapsed output, sanitized text output, and an item-level Cancel action.
- Context-excluded `!!` entries receive a visibly distinct dimmed presentation while normal commands retain bash-mode emphasis.

**Review status:** approved

## Steps

**Pre-implementation commit:** `55ca43f02b805e960e6ec4135e2eb6243ad1753e`

### Step 1: Map native bash events and persisted results

Update `server/src/event-buffer.ts` to map the SDK-owned `bash_execution_update` variant directly to the wire event, preserving its optional `id` and `delta`, and classify it with the existing live-only streaming updates so it is sent to the slot owner but never inserted into the replay ring. Keep the `AgentSessionEvent`-derived input union and exhaustive switch intact; do not add a local SDK shadow type or synthesize agent/message lifecycle events. Make an event history containing only deliberately non-replayable updates yield an empty replay rather than a stale-cursor result, without changing the existing overflow behavior for evicted buffered events.

Update the `bashExecution` branch in `server/src/message-mapper.ts` to preserve `command`, `output`, `exitCode`, `cancelled`, `truncated`, optional `fullOutputPath`, and optional `excludeFromContext` on the `PimoteAgentMessage` while retaining the `$ <command>\n<output>` text block. This one mapping must serve both direct messages and `mapContextEntries()` resync output.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/event-buffer.test.ts src/message-mapper.test.ts` passes, including identified/id-less live updates, non-replay, and context-entry metadata preservation.
**Status:** done

### Step 2: Route bash execution and cancellation through the live session

In `server/src/ws-handler.ts`, add `bash` and `abort_bash` to the existing session-command dispatch list and implement both cases in `handleSessionCommand()`. For `bash`, reject before extension interception when `session.isBashRunning` is true with the exact `bash_already_running` error. Otherwise, normalize `excludeFromContext` to a boolean and call `session.extensionRunner.emitUserBash({ type: 'user_bash', command, excludeFromContext, cwd: session.sessionManager.getCwd() })`. If the extension returns a complete result, record it exactly once with `session.recordBashResult()`; otherwise await `session.executeBash(command, undefined, { id, excludeFromContext, operations })`, relying on that native method to record its own result. Return both paths as `{ result }` in the successful response. For `abort_bash`, call `session.abortBash()` and respond successfully without touching `session.abort()` or model-stream state. Do not gate either path on `session.isStreaming`.

**Verify:** `npm run test --workspace=@pimote/server -- --run src/ws-handler.test.ts` passes the native bash command group, including required session scope, streaming concurrency, extension results/operations, conflict rejection, and bash-only abort.
**Status:** done

### Step 3: Implement parsing and per-session bash reduction

Implement `parseBangBashCommand()` in `client/src/lib/bash-command.ts` as a pure parser: trim outer whitespace, recognize `!!` before `!`, trim only the command boundary, preserve the command's internal shell text, and return `null` for ordinary text or an empty/bare prefix.

Implement the `startBash`, `updateBash`, `completeBash`, `failBash`, and `clearBash` operations in `client/src/lib/stores/session-registry.svelte.ts` against the existing per-session `bashExecutions` record. Start creates a running entry with empty output. Updates append only to a matching running entry; an id-less update may target only the sole running entry, and unknown, ambiguous, completed, or errored targets are ignored. Completion treats `BashResult.output` as canonical, appends one ordinary `bashExecution` message containing the command/result/exclusion metadata and `$ <command>\n<output>` text, advances `messageKeys` and `messageCount` in lockstep, then removes the transient entry so later updates cannot resurrect it. Failure retains the existing transient entry with `status: 'error'` and its transport/server error without adding a message. Clearing replaces only the transient record; retain the current full-resync rebuild, which already starts from an empty record.

**Verify:** `npm run test --workspace=client -- --run src/lib/bash-command.test.ts src/lib/stores/session-registry.test.ts` passes the parser, correlation fallback, canonical completion, cancellation-result promotion, dispatch-error, late-update, and resync cases.
**Status:** done

### Step 4: Dispatch bang commands before every prompt path

Update `client/src/lib/components/InputBar.svelte` to import the parser and `BashResponseData`, then branch on a parsed bang command immediately after the send guard and before `/login`, `/compact`, streaming steer, or ordinary prompt handling. Capture the current session ID, create a caller-owned `crypto.randomUUID()` request ID, call `sessionRegistry.startBash()` before sending, and send `{ type: 'bash', id, sessionId, command, excludeFromContext }`. Clear the submitted text/draft/autocomplete state when dispatch begins so a long-running command does not pin the composer; do not attach or discard staged prompt images. Resolve a successful `{ result }` response through `completeBash()` using the captured session/ID, and route an unsuccessful response or rejected promise through `failBash()` with the server error or thrown `Error.message`. Leave bare bangs and every existing non-bash branch unchanged.

**Verify:** `npm run test --workspace=client -- --run src/lib/components/InputBar.bash.test.ts src/lib/bash-command.test.ts` passes; in particular, a bang submitted during model streaming sends `bash`, never `steer`, and both server failures and transport rejection remain visible in session state.
**Status:** done

### Step 5: Build the dedicated bash presentation module

Replace the stub in `client/src/lib/components/BashExecution.svelte` with the complete presentation behind its existing `BashExecutionProps` interface. Normalize transient and finalized inputs into derived command, output, exclusion, and result/status values; render the literal `$ command`, output in an escaped text/preformatted node (never `{@html}`), and status text for running, successful completion, nonzero exit, cancellation, truncation/full-output path, and dispatch errors. Bound long output to a ten-line preview with local `Show more`/`Show less` expansion. Expose `Cancel` only for a running transient with an `onCancel` callback. Give the root one distinct bash accent treatment and a separate dimmed class for `excludeFromContext` so callers do not duplicate these rules.

**Verify:** `npm run test --workspace=client -- --run src/lib/components/BashExecution.test.ts` passes all status, expansion, cancellation, exclusion-style, and markup-escaping assertions.
**Status:** not started

### Step 6: Integrate transient and persisted bash entries into the conversation

In `client/src/lib/components/Message.svelte`, add a `bashExecution` role branch that delegates finalized messages to `BashExecution.svelte` instead of falling through to generic system-message rendering. In `client/src/lib/components/MessageList.svelte`, render the viewed session's transient executions after its ordinary conversation entries in record insertion order, pass a bash-specific cancel callback that sends `{ type: 'abort_bash', sessionId }`, and never reuse the model `handleAbort()` path. Account for transient entries in the empty-state and auto-scroll dependencies so running output and retained dispatch errors remain visible and follow live output. Let `completeBash()`'s promotion/removal make the dedicated finalized branch replace the transient without duplication.

**Verify:** `npm run test --workspace=client -- --run src/lib/components/MessageList.bash.test.ts src/lib/components/BashExecution.test.ts` passes for transient ordering, dispatch errors, persisted rendering, and independent cancellation.
**Status:** not started

### Step 7: Run full automated and live-path validation

Rebuild the shared protocol output, then run formatting, linting, type checks, the complete server/client suites, and the production build. In a live browser session, start a slow `!` command while the model is streaming, confirm output arrives incrementally and item-level Cancel stops only bash, then run a nonzero command and a `!!` command and confirm their final statuses and exclusion styling. Reconnect/full-resync and confirm no transient duplicate remains; context-visible results rehydrate with their metadata, while an excluded result may disappear under the existing context-only resync policy.

**Verify:** `npm run build:shared`, `npm run format:check`, `npm run lint`, `npm run check`, `npm run test --workspace=@pimote/server -- --run`, `npm run test --workspace=client -- --run`, and `npm run build` all pass, followed by the live checks above.
**Status:** not started
