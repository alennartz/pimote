# Brainstorm: Session ownership redesign

## Context

Pimote binds each session to one client. A session slot holds one `connection`, tied to one persisted `clientId` (DR-005). Opening from another client returns `session_owned`. `force` displaces the current owner. Two problems came out of this model:

- **Archive ping-pong.** Archive clears when any client reopens the session. A client that boots with the session in localStorage sends a `force` open and unarchives it. An archived session comes back on every boot of a stale client.
- **No shared live view.** Two connections cannot watch the same live transcript or both send to it. The user wants both.

The model also bundles four jobs into one pointer: command rights, event routing, reaper protection, and voice-call holder.

## The idea

Replace single-client ownership with simultaneous observers. One session has any number of connected clients. Each one sees the live transcript and can send. Ownership, displacement, and takeover go away.

## Key decisions

**One event buffer per session, one cursor per connected client.**
The buffer holds the session's events once. Each client keeps a pointer into it, so each client knows where it is up to. Reconnect replays from that client's cursor. This keeps per-session storage and avoids a copy per observer.

**Ownership is removed.**
`slot.connection` becomes a set of connections. `isOwnedByMe`, `session_owned`, `pendingTakeover`, takeover confirm, and displacement go with it. Owning a session stops being a state the server or the client tracks.

**Open is one operation, not soft and force.**
Without ownership, `force` has no meaning. Boot restores, route loads, reconnect restores, and notification taps all open the same way. Explicit takeover paths disappear.

**Archive closes the session on every client.**
Archive runs the close path for every connected client. Close aborts a working agent through `runtime.dispose()`, so archive does too. Clients that are not connected still see the flag on their next list refresh.

**Opening never unarchives.**
Open, reconnect, and localStorage restore do not clear the archive flag. The only way back is an explicit unarchive. This fixes the archive ping-pong at its source.

**An archived session rejects open with `session_archived`.**
The client keeps the session archived and drops it from its local restore set. A stale client stops reopening it on boot.

**Sends queue in arrival order.**
Messages from any connected client enter the same queue. The agent handles them in order. Nothing is rejected for being busy.

**The first answer wins an extension dialog.**
Every connected client shows a pending dialog. The first response resolves it. The others close their copy.

**Any connected client can abort, rename, or archive.**
Abort applies to the whole session. Permissions do not vary by client.

**One voice call per session. Any connected client can start it.**
A second call start is rejected while a call is active. Nothing displaces. This replaces the single-owner displacement described for voice in DR-013 and in the Android voice brainstorm (`docs/brainstorms/voice-mode-android.md`, "Single-owner displacement model"). Those documents need updating when this design lands.

**The reaper protects a session while any client is connected.**
"Has a connected client" becomes "the connection set is non-empty."

## Direction

- `slot.connection` becomes a set of connections. Each connection carries its own cursor into the shared buffer.
- Event fan-out sends each event once to the buffer and advances each observer when it delivers.
- The open path loses its `force` parameter and its displacement branch.
- The archive path calls close for each live session, then writes the flag.
- The client removes takeover UI and the `pendingTakeover` state. It drops archived sessions from the restore set when the server returns `session_archived`.

## Open questions

### Sharp (handoffs to architecting)

- **Fan-out and cursors.** `sendSlotEvent` targets only `slot.connection`. Fan-out needs the connection set, and each connection needs a cursor. Architecting must define where the cursor lives and how eviction from the buffer forces a full resync for a lagging client.
- **Call sites.** Find every use of `slot.connection`, `connectedClientId`, `isOwnedByMe`, `displaceOwner`, `claimSession`, and `force` on `open_session` or `call_bind`. Each needs a decision under the new model.
- **Reconnect and replay.** The reconnect restore loop and `lastCursor` replay assume one client per session. Confirm they hold with per-client cursors.
- **Stale connections.** A connection that drops must release its cursor and leave the set. Confirm the cleanup path covers this.

### Fog

- **Abort and partial output.** Abort through `dispose()` may leave a partial assistant turn. Whether it persists, and what observers see, is unchecked.
- **`viewedSessionId` per connection.** Each client's active view is per connection already. Whether any server state needs to change for it is unclear.
- **Voice call during fan-out.** A call's audio leg is tied to one call holder in practice even when any client can start it. Whether the call should show on every observer's UI is unsettled.
