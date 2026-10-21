# DR-077: Replay cursors start at a wall-clock base

## Status

Accepted

## Context

Each live session slot owns an `EventBuffer`, and DR-067 gives every observer its own cursor into it. A client stores one integer per session id and sends it back as `lastCursor` on reconnect. Cursors started at 0 in every new buffer, and nothing tied a cursor to the buffer that issued it.

A session id outlives its buffer. The idle reaper closes a slot once its last observer detaches, a server restart drops every slot, and a voice `call_bind` reopens a dormant session (DR-070). Under shared observers, another client often reopens the session first and advances the new buffer. A returning client's old cursor then means nothing. `replay()` treated a cursor at or above the current one as caught up and returned nothing. A lower cursor replayed the new buffer's events on top of an unrelated transcript. Either way the client silently diverged until a full resync.

## Decision

Start each production buffer's cursor at `Date.now() * 1000`. `replay()` returns `null`, which forces a full resync, for a cursor below the buffer's base or above its current cursor. Only the current cursor counts as caught up. Within a buffer, cursors still advance by one per event.

A recreated slot therefore issues cursors above every cursor its predecessor handed out, as long as the predecessor emitted fewer than 1000 events per millisecond of its lifetime. A stale cursor falls below the new base. The "above the current cursor" rule catches the rest, including most cases where the clock moved backward between buffers.

Rejected alternatives:

- **A random buffer epoch on the wire.** The client would send `{ lastCursor, epoch }`, and a mismatch would force a resync. This is the most explicit design, but every path that opens or resets a session must deliver the epoch: the open responses, `full_resync`, and session replacement. It is a protocol change for the PWA and a mirror change for Android, and any missed path reopens the hole.
- **A process-wide monotonic counter.** It resets on server restart, which is one of the cases this decision must cover.
- **Persisting cursors with the session file.** This adds write traffic per event to fix a reconnect concern.

## Consequences

- **No wire change:** the fix lives in the server alone. The client and Android need no change. Android already holds the cursor as a `Long`.
- **Clock dependency:** correctness now depends on the wall clock. If the clock jumps backward far enough between two buffers for the same session, a stale cursor can land inside the new buffer's range. Revisit the epoch design if pimote runs where clocks are unreliable.
- **Large values:** cursors are now large integers, about 1.8e15 today, below `Number.MAX_SAFE_INTEGER` until roughly the year 2255. Code that formats or logs cursors sees these values, and tests that build a buffer without a base still count from 0.
- **No cursor on `full_resync`:** the client keeps its pre-resync cursor after a full resync. This is safe because a cursor from an earlier buffer always replays as stale.
