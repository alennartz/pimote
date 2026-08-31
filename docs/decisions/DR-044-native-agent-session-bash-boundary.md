# DR-044: Native AgentSession boundary for leading bang commands

## Status

Accepted

## Context

Pimote needed Pi TUI-compatible leading `!` and `!!` commands so an authorized client could run shell text directly in the active pi session, including while an agent turn was streaming. The server already embeds pi through `AgentSession`, but a shell command could also have been implemented with a server-side `child_process` or sent through the normal prompt/steering path. The feature additionally needed incremental output, native cancellation, extension interception, and Pi's history/context semantics without turning every output chunk into durable replay state.

Reconnect behavior was constrained by Pimote's existing context-based session synchronization: context-visible persisted messages can be rebuilt, while `!!` entries are intentionally allowed to be absent from that view.

## Decision

Route leading bang commands through pi's native user-bash and `AgentSession` APIs. The server first offers the command to the session's user-bash extension hook; when it is not handled there, it calls `executeBash()` with the caller's request ID, context-exclusion flag, and extension operations. Extension-supplied complete results are recorded exactly once. A separate `abort_bash` command invokes `abortBash()` and never uses the model abort path.

Map the real SDK `bash_execution_update` event to a session-scoped wire event and forward deltas live to the current session owner without placing them in the replay ring. The final native result and subsequent message/context synchronization are the durable boundaries. The client keeps a transient, request-correlated execution while output is live, promotes the canonical final result to a normal bash message, and reconciles accepted commands after reconnect through full session resync. Context-visible results rehydrate; an excluded `!!` result may disappear under the existing context-only synchronization policy.

## Consequences

- Pi remains the source of truth for shell, working directory, command interception, output limits, history recording, result status, and cancellation; a single running-bash guard prevents ambiguous command correlation.
- Live output is best-effort and owner-scoped rather than replayed. A disconnected client can retain a pending cancellation affordance and reconcile against the eventual durable result, but it cannot recover intermediate deltas.
- `!!` is visibly rendered during the live interaction and carries exclusion metadata, but its omission after context-only resync is an accepted trade-off rather than a new scrollback-persistence contract.
- The feature inherits the existing session trust boundary: any authorized session controller can execute arbitrary shell commands in that workspace. The server and client are coupled to the pi SDK's native bash API, and the protocol/reducer need additional transient-state handling, but no second shell implementation or model-dependent execution path is maintained.

Rejected alternatives:

- **Server-side `child_process` execution.** Rejected because it would bypass pi's configured shell/cwd, user-bash interception, native history/context recording, truncation metadata, and `abortBash()` semantics.
- **Routing through `prompt` or streaming steer.** Rejected because execution would depend on model behavior, could be queued or interpreted as text, would not provide native bash status/cancellation, and would block the required concurrency with an active model turn.
- **Replay every output delta.** Rejected because high-volume transient chunks would inflate the replay ring and reconnect could duplicate output; the final result plus session synchronization is the canonical boundary.
- **Persist `!!` in a new scrollback channel.** Rejected as out of scope: it would broaden Pimote's existing context-only resync contract solely for this feature.
