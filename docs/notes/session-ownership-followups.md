# Session ownership follow-ups

Parked items from the session-ownership topic. None blocks the shipped change.

## Abort clears the shared queue (decided, not implemented)

Decision: abort removes every queued message. Each sender's client restores its own queued messages as drafts. The aborting client restores only its own. Other observers see their drafts restored in their own composers.

Current behavior: `abort` calls `session.clearQueue()` and returns all queued messages to the aborting client only (`server/src/ws-handler.ts`, `case 'abort'`).

Work needed: tag queued messages with the sender's `clientId`, and send each sender its own drafts on abort.

## Abort and partial output (unchecked)

Unknown: whether an aborted partial assistant reply persists to the session file, and what observers see for it. Abort uses `session.abort()` and keeps the session open. Verify the persistence path before relying on it.

## Conflict narrowing (blocked on pi)

Today any external `pi` process in the same folder raises `session_conflict`, even when it runs a different session. Narrowing needs pi to expose the open session id through a lock, a command-line argument, or a status file. Pi writes session files with `appendFileSync` and holds no open file handle, so an open-file check cannot detect it.

## Voice-call visibility on observers (product question)

Only the call holder receives call state. Non-holder observers see the call's transcript messages but no call indicator. Options: nothing; a read-only "call active" badge; a badge that can end the call. Likely settled in the personas calling rework.
