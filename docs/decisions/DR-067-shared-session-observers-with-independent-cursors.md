# DR-067: Shared session observers with independent cursors

## Status

Accepted

## Context

Pimote's single session owner combined command access, event routing, replay progress, idle-reaper protection, and takeover behavior. That model prevented two clients from watching or driving one live transcript. The archive path also made stale local restores able to reopen a session. DR-005 already defines one persisted `clientId` per browser tab, so the redesign needs simultaneous observers without changing identity.

## Decision

Represent each live session with a map of observers keyed by `clientId`. Each observer has its own socket and read cursor into one shared `EventBuffer`. Fan out session events to every open observer, advance only the cursor that receives a cursor-bearing event, and fall back to full resync when buffer eviction passes an observer's cursor. Any observer can send commands; the existing arrival-order prompt queue remains the ordering mechanism. A second socket with the same client ID replaces the first. The reaper protects a slot while the observer map is non-empty.

We rejected one shared cursor because a slow observer would force every client to replay or retain the same history. We rejected a separate event buffer per client because it multiplies storage and complicates session reconstruction. We rejected retaining an owner with read-only viewers because it preserves takeover races and still prevents every client from sending.

## Consequences

- Session ownership, takeover confirmation, `session_owned`, and session-level displacement disappear from the wire and client state.
- A disconnected observer releases its cursor and no longer protects the session from reaping; another observer keeps the slot live.
- High-volume ephemeral events can fan out without advancing replay positions, while persisted events retain independent recovery points.
- Multiple clients can issue prompts, aborts, archive commands, and other session operations. The session remains a shared command surface, not a permission boundary.
- The Android mirror takes a hard wire cut and must update before it can consume the observer contract.

## References

- `docs/plans/session-ownership.md` (final artifact at commit `95003b461e61e30783253a5e442b0b9b3e451353`) — Observer record, fan-out, reaper, and wire removals
- `docs/brainstorms/session-ownership.md` (artifact at commit `659388db604377ea8d6bd21de5ddb25b4ec66df4`) — One buffer and one cursor per observer
- `docs/decisions/DR-005-persistent-client-identity-over-multi-tab.md` — Identity retained by this decision
