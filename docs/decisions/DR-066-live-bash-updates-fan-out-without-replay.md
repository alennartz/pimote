# DR-066: Live bash updates fan out without replay

## Status

Accepted

## Context

Pimote needs Pi-compatible `!` and `!!` commands while an agent turn runs. DR-044 chose Pi's native `AgentSession` and user-bash APIs, with live deltas sent to one session owner. Session ownership is now removed, so owner-scoped routing no longer describes the system. The replay ring must still avoid high-volume transient chunks, and context-only resynchronization still permits an excluded `!!` result to disappear.

Supersedes DR-044 (Native AgentSession boundary for leading bang commands), deleted at commit `b7d70e79cde859b77c9fe823e98aaf0d09ffb384`.

## Decision

Keep every surviving DR-044 boundary: route leading bang commands through Pi's native user-bash and `AgentSession` APIs; preserve extension interception, native history and context behavior, native cancellation, and the separate `abort_bash` path. Keep live deltas out of the replay ring. Keep the final native result and subsequent context synchronization as the durable boundary, including the existing exclusion metadata for `!!`.

Map each cursor-free `bash_execution_update` to every connected session observer. A late observer receives the final persisted bash result and context sync, not earlier chunks. This replaces only DR-044's owner-scoped delivery rule.

We rejected replaying every delta because high-volume transient chunks would inflate the ring and duplicate output after reconnect. We rejected a second durable bash stream because the final Pi result already defines the canonical state. Sending deltas only to an owner is no longer possible because no session has an owner.

## Consequences

- All connected observers see best-effort live output and can keep their transient execution state aligned.
- A disconnected observer cannot recover intermediate chunks; it receives the final result when it reconnects or joins late.
- Late observers see Pi's normal output limits and truncation, so their final result can be shorter than the live stream.
- The wire, reducer, and server remain coupled to Pi's native bash API, but Pimote does not maintain a second shell implementation.

## References

- `docs/plans/session-ownership.md` (final artifact at commit `95003b461e61e30783253a5e442b0b9b3e451353`) — Session ownership redesign, DR Supersessions and Live bash output
- `docs/brainstorms/session-ownership.md` (artifact at commit `659388db604377ea8d6bd21de5ddb25b4ec66df4`) — Shared observer direction
