# DR-068: Archive is a closed session state

## Status

Accepted

## Context

Opening a session used to clear its archive flag. A stale browser tab that restored a session from local storage could therefore unarchive it on boot, creating archive ping-pong across clients. The observer redesign also makes an archive operation span several live clients, so metadata alone cannot describe the resulting state.

## Decision

Archiving a live session closes every observer through the normal close path, resolves pending extension UI, disposes the runtime, and emits `session_closed` with reason `archived` before publishing the archived metadata. An unarchive operation clears only the archive flag; it does not reopen or recreate the runtime. Any soft open of an archived session rejects with `session_archived` before hooks, attachment, or restore work and never clears the flag. A user must unarchive explicitly and then open the session.

We rejected implicit unarchive because stale local restores would keep resurrecting archived sessions. We rejected changing only the metadata because a working runtime and connected observers would survive an operation that users understand as closure. We rejected silently dropping an archived open because clients need a stable error to remove the session from their restore set while retaining any local transcript.

## Consequences

- Archive aborts active work and closes every connected observer, including observers on other devices.
- Unarchive is a metadata operation, so the next open starts a fresh live slot while persisted session data remains available.
- Clients must handle `session_archived` and stop restoring that session until an explicit user action makes it restorable.
- Archive and open are serialized so an open cannot attach during runtime disposal.

## References

- `docs/plans/session-ownership.md` (final artifact at commit `95003b461e61e30783253a5e442b0b9b3e451353`) — Archive, open, and archived restore decisions
- `docs/brainstorms/session-ownership.md` (artifact at commit `659388db604377ea8d6bd21de5ddb25b4ec66df4`) — Archive ping-pong problem and explicit unarchive direction
