# DR-069: Isolate the single voice holder from session observers

## Status

Accepted

## Context

Shared session observers make transcript access and commands multi-client, but a voice call still has one media leg and one call control surface. The observer brainstorm proposed allowing any observer to take the call, while the implementation plan retained a single holder to avoid changing the calling personas and protocol. Treating the call holder as the session owner would reintroduce the displacement behavior that the observer redesign removes.

## Decision

Track one `callHolder` client ID per session in the voice orchestrator, independently of session observers. The first `call_bind` becomes the holder. A second bind fails with `call_bind_failed_owned` unless it uses `force`; forced binding ends the old call and sends `call_ended` with reason `displaced` only to the old holder, then records the new holder. Ending, extension deactivation, and shutdown clear the holder. The session stays open, and the old holder never receives a session-level close.

We rejected multiple simultaneous calls because the speech and media path has one leg and would need a new coordination protocol. We rejected using the observer map as call ownership because it would couple voice transfer to session lifecycle and bring session displacement back into the wire contract. The targeted call-level transfer keeps DR-013's single-holder voice model while allowing shared transcript observation.

## Consequences

- Any observer can start a call, but only one client controls the active call at a time.
- Forced transfer requires targeted client notification and preserves the session for every observer.
- The idle reaper must treat an active call holder as activity even when no transcript observer remains connected.
- Android and web clients retain call-level `displaced` handling while session-level displacement vocabulary stays removed.

## References

- `docs/plans/session-ownership.md` (final artifact at commit `95003b461e61e30783253a5e442b0b9b3e451353`) — Voice call holder and DR-013 status
- `docs/brainstorms/session-ownership.md` (artifact at commit `659388db604377ea8d6bd21de5ddb25b4ec66df4`) — Original multi-observer call proposal
- `docs/decisions/DR-013-pwa-first-voice-client-android-deferred.md` — Existing single-holder voice model
