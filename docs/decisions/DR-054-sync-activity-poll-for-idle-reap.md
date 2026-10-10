# DR-054: sync activity poll for idle reap

**Status:** Accepted
**Date:** 2026-07-21
**Decider:** Alennartz
**Supersedes:** —
**Superseded by:** —

## Context

The idle reaper closes sessions with no connected client once they idle past a timeout. The existing guards (agent status, bash execution, the extension-admission window) cover work the root session sees, but extensions can hold live background work the session never observes — for example non-awaited subagents still running after the root turn settles. The reaper would destroy that work. "Something is still running" is invisible to the server without a signal from the extension.

## Decision

Add a synchronous background-activity poll on the session's EventBus, shipped in `@pimote/sdk/activity`. Extensions register `answerActivity(pi, isActive)` with a synchronous predicate; the server's idle reaper calls `askActivity(bus)` — an inline `pimote:activity:request` emit whose `pimote:activity:response` answers are captured before the call returns, mirroring the `panels/detect` round-trip. Only sessions already past the idle threshold are polled, so the poll is invisible until it matters.

Semantics:

- **Fail open.** No responder, or every responder answering `active: false`, means the session may reap as before.
- **OR over responders.** Any responder asserting `active: true` holds the session.
- **Throw parks the session.** A throwing predicate answers `active: true`: a broken responder parks the session (recoverable by explicit close) instead of destroying work.
- **Extension policy.** The callback decides what counts as live work; pimote learns only the boolean.

We rejected an async poll: on an async round-trip a missing answer is indistinguishable from a slow one, forcing the reaper into timeout bookkeeping or a race against close. The sync round-trip keeps the reaper's decision atomic. We rejected making the poll authoritative over the existing guards: it is a final gate after them, asked only when every other signal says idle.

## Alternatives Considered

1. Track background work from the server (extension reports subagent starts/stops over new events). Rejected: pushes per-agent bookkeeping into the protocol for a question only the extension can answer.
2. Reuse the existing idle-since timestamp with a longer timeout. Rejected: a wall-clock guess cannot distinguish "settled" from "background work in flight".

## Consequences

- Extensions managing background agents can protect their sessions with one registration; with no responder, reaping is unchanged.
- The predicate must be synchronous; an async answer is indistinguishable from no answer.
- A wedged responder can hold a session open indefinitely; the explicit close path is the recovery.
- The protocol lives in the SDK (`askActivity` ships alongside `answerActivity`) so server and extensions share one module.

## References

- `packages/sdk/src/activity/` — the seam
- `server/src/session-manager.ts` — idle reaper poll site
