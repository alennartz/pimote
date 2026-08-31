# Native `!` Bash Commands

## Idea

Mirror Pi TUI’s leading-exclamation command in Pimote: typing `!cmd` executes a shell command directly through the live Pi session rather than asking the model to use its bash tool.

## Key decisions

- **Use Pi’s native session execution.** The server will call the live session’s `executeBash` path. This preserves the session cwd, configured shell and command prefix, extension interception, output truncation, history recording, and cancellation. A separate `child_process` route would diverge from Pi; routing through `prompt` would make execution model-dependent.
- **Support both `!` and `!!`.** `!cmd` records a normal `bashExecution` message; `!!cmd` records the same visible result with `excludeFromContext`, matching Pi’s context behavior.
- **Allow execution during model streaming.** Pi treats bash as a separate session activity: it can run concurrently with the model, appears in the pending area, and is finalized independently. Pimote must not infer bash completion from agent lifecycle events.
- **Preserve native result semantics.** Show command, streaming output, exit status, cancellation, and truncation. Nonzero exits are completed bash results, not prompts or generic errors.
- **Provide cancellation.** The client needs a bash-specific abort path backed by Pi’s `abortBash`, so an active command can be stopped without aborting the model run.
- **Keep shell parsing server-side.** After removing the leading `!` or `!!` and trimming the command boundary as Pi does, the client sends the command text without attempting shell parsing or escaping.
- **Use the existing session trust boundary.** Any client already authorized to control a session can execute arbitrary commands in that session’s workspace; the feature does not introduce a second permission model.

## Direction

Add a session-scoped `bash` WebSocket command carrying the command and `excludeFromContext` flag. The server invokes Pi’s native user-bash/`executeBash` flow, forwards correlated live output updates, returns the final bash result, and lets Pi persist the `bashExecution` message. Extend the client input bar to recognize leading `!`/`!!`, render a pending/finalized bash item alongside chat, and route cancellation to `abortBash`. Extend event mapping and replay handling so finalized messages survive reconnects while in-flight output remains correlated and best-effort.

The feature is a direct transport of Pi’s existing interactive behavior, not a new shell abstraction.

## Open questions

### Sharp questions

- Which shared wire shape should represent a live bash output update and final result while remaining compatible with the installed Pi SDK’s `bash_execution_update` event?
- Should replay include a completed bash result as a dedicated event, or rely solely on the persisted message fetched during session synchronization?
- How should multiple connected clients render and correlate simultaneous bash commands, especially when one client starts or cancels a command?
- What exact client control should invoke `abortBash` when a command is active (keyboard escape, stop button, or both) without interrupting a concurrent model stream?

### Fog

- The best visual distinction between a pending bash item and a normal tool call may depend on the existing chat component layout and mobile constraints.
- The interaction between bash output, compaction, and queued steering messages may expose SDK-specific timing details during architecture and testing.
