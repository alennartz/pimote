# Plan: Session ownership redesign

## Context

Pimote binds each session to one client. Opening from another client returns `session_owned`, and `force` displaces the owner. Archive clears when any client reopens the session, so a stale client that boots with the session in localStorage unarchives it. The goal is simultaneous observers: several connected clients watch one live transcript and any of them can send. See `docs/brainstorms/session-ownership.md`. Where this plan differs from that brainstorm, the plan records the change and its reason.

## Architecture

### Impacted Modules

**Server.** `ManagedSlot.connection` becomes a set of observers, keyed by `clientId`. Each observer holds a read position into the shared `EventBuffer`. Fan-out, open, archive, reaper, and conflict checks change. Ownership code is removed. The voice orchestrator tracks its own call holder.

**Protocol.** Removes ownership vocabulary: `SessionInfo.isOwnedByMe`, `OpenSessionCommand.force`, the `session_owned` rejection, the session-level `displaced` close reason, and `remoteSessions` on `SessionConflictEvent`. Keeps `CallBindCommand.force` and the call-level `displaced` reason.

**Web Client.** Removes the takeover banner and `pendingTakeover` state from `session-registry.svelte.ts`. Restores and route loads send a plain open. On `session_archived`, the client drops the session from its restore set. It handles the `archived` close reason. It stops reading `remoteSessions`.

**Agent Extensions (voice).** The orchestrator records the call holder per session. `call_bind` with `force` displaces that holder only. It no longer reads `slot.connection`.

**Android Client.** Hard cut, as DR-056 accepted for folder listing. The mirror loses `isOwnedByMe`, the `open_session` force field, and the session-level `displaced` reason. It keeps `call_bind` force and call-level `displaced`. Android stays broken until its own update lands.

**Development Tooling.** `docs/MANUAL-TEST-PLAN.md` TP-11 and TP-12 describe takeover and displacement. They need rewriting to match observers.

### New Modules

None.

### Interfaces

**Observer record (server, per session slot).**

```ts
interface SessionObserver {
  clientId: string; // DR-005 identity; one per browser tab
  ws: EventSocket;
  cursor: number; // cursor of the last event delivered to this observer
  onSessionReset: ((slot: ManagedSlot, outcome: SessionResetOutcome) => Promise<void>) | null;
}

// ManagedSlot
observers: Map<string, SessionObserver>; // keyed by clientId
```

A second socket with the same `clientId` replaces the first. This keeps the existing eviction in `server.ts`.

**Fan-out.** `sendSlotEvent(slot, event)` sends the event to every observer with an open socket. After each delivery it sets `observer.cursor` to `event.cursor` when the event has one. Ephemeral events, such as live bash deltas, carry no cursor and leave the cursor unchanged.

**Attach and detach.**

- `attachObserver(sessionId, observer)` adds or replaces the entry. It runs the existing claim work: extension binding on first attach, pending UI replay, panel resync. It does not displace anyone.
- `detachObserver(sessionId, clientId)` removes the entry. Connection cleanup calls it for every subscribed session.

**Reaper.** A session is protected while `observers.size > 0`.

**Sends.** A send from any observer enters the existing prompt path. The existing queue orders sends in arrival order. This plan adds no queue and no busy rejection.

**Extension dialogs.** UI requests go through `sendSlotEvent`, so every observer receives them. The first `extension_ui_response` for a request ID resolves it and removes its pending entry. Later responses for that ID find no entry and are dropped.

**Open (`open_session`).** The command has no `force` field. Behavior:

1. If the session is archived, return error `session_archived`. Clear nothing.
2. Otherwise attach the observer and sync from `lastCursor`, as today. The replay path is unchanged.

**Archive (`archive_session`).**

- `archived: true`: close the session on every server-side slot, then set the flag. Each close sends `session_closed` with reason `archived` to every observer. The close path aborts a working agent through `runtime.dispose()`.
- `archived: false`: clear the flag only. The session stays closed until a soft open.

**Conflict (`session_conflict`).** Emitted on open when an external `pi` process runs in the folder. The `remoteSessions` field is removed. Detection stays folder-scoped, because pi does not expose which session an external process runs.

**Voice call holder.**

```ts
// voice orchestrator state, per session
callHolder: Map<string, string>; // sessionId -> clientId of the active call
```

- `call_bind` with no active call records the caller as holder.
- `call_bind` with an active call and `force: false` returns `call_bind_failed_owned`.
- `call_bind` with `force: true` sends `call_ended { reason: 'displaced' }` to the old holder and records the new one.
- `call_ended` clears the holder.
- The old holder gets no `session_closed`. The session is not displaced.

**Live bash output (DR-044).** `bash_execution_update` deltas go to every connected observer. They stay out of the replay buffer. A late joiner receives the final bash result and context sync when the command completes. Pi's output limits and truncation apply to that result, so it can be shorter than the live stream.

**Wire removals (hard cut).**

- `SessionInfo.isOwnedByMe`
- `OpenSessionCommand.force`
- `open_session` error `session_owned`
- session-level `session_closed` reason `displaced`
- `SessionConflictEvent.remoteSessions`

**Wire additions.**

- `session_closed` reason `archived`
- `open_session` error `session_archived`

### Technology Choices

None.

### DR Supersessions

- **DR-044** (Native AgentSession boundary for leading bang commands) — superseded in part because its decision forwards live bash deltas "to the current session owner," and ownership is removed. New decision: live deltas go to every connected observer. Live output stays out of the replay buffer, and a late joiner receives the final result on completion. The no-replay decision stands.

DR-005 and DR-013 stand. DR-005 keeps one tab per browser, so the identity model is unchanged. DR-013 keeps single-holder voice calls, so the call holder model is unchanged.

## Decisions and their reasons

Each reason below comes from the discussion. Where none was given, the entry says so.

- **Identity: keep DR-005.** One tab per browser, `clientId` persisted in localStorage. No reason was stated. Observers still work across devices.
- **Per-client pointers are read positions only.** The buffer still evicts by capacity. A pointer that falls past eviction gets a full resync, as reconnect does today.
- **Conflict means a second harness on the same session file.** Pimote's own sessions cannot conflict. External `pi` processes can, because they may drive the same session file. Pi exposes no session id in its command line, and no session-file lock appears in pi's core, so detection cannot narrow.
- **Voice keeps a single call holder for now.** This revises the brainstorm's "any observer may take the call." The reason: avoid code churn before the personas rework calling.
- **Archive closes the session everywhere.** Unarchive is `archive_session` with `archived: false`, which is separate from open.
- **Opening never unarchives.** Archived sessions reject a soft open with `session_archived`.
- **Late joiner waits for the final bash result.** The owner accepted this. Partial output stays unavailable to late joiners.

## Open items

### Fog (carried from the brainstorm)

- **Abort and partial output.** Abort goes through `runtime.dispose()`. Whether a partial assistant turn persists, and what observers see, is still unchecked.
- **Narrowing conflict detection.** It needs pi to expose the open session, through a lock or a command-line argument. Neither exists today.
- **Voice call visibility on observers.** The call holder is one client. Whether other observers see the call state is unsettled.

### Sharp (for implementation)

- **Call sites.** `slot.connection` appears in about 25 places across `ws-handler.ts`, `session-manager.ts`, `server.ts`, `index.ts`, and `voice-orchestrator-boot.ts`. Each one needs the observer or call-holder replacement above.
- **Session-closed reason `archived`.** Clients must handle it. The Android mirror also needs it.
- **Manual-test plan.** TP-11 and TP-12 describe takeover and displacement and will fail as written.
