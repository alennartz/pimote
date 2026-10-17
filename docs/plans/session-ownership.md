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

- `attachObserver(sessionId, observer)` adds or replaces the map entry only. It does not displace anyone. `WsHandler.claimSession` keeps the claim work: extension binding on first attach, pending UI replay to the attaching observer, panel resync. See Decisions.
- `detachObserver(sessionId, clientId)` removes the entry. Connection cleanup calls it for every subscribed session.

**Reaper.** A session is protected while `observers.size > 0`.

**Sends.** A send from any observer enters the existing prompt path. The existing queue orders sends in arrival order. This plan adds no queue and no busy rejection.

**Extension dialogs.** UI requests go through `sendSlotEvent`, so every observer receives them. The first `extension_ui_response` for a request ID resolves it and removes its pending entry. Later responses for that ID find no entry and are dropped. The server sends `extension_ui_resolved { sessionId, requestId }` to every observer except the answering client. Each recipient closes only that matching dialog. Unknown resolution IDs do nothing.

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
- `call_ended` clears the holder, including extension self-deactivation and shutdown.
- `VoiceOrchestratorOptions.notifyClientCallEnded(clientId, event)` routes `call_ended` to a specific holder. This seam carries `{ type: 'call_ended', sessionId, reason }` and never closes the session.
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
- `extension_ui_resolved { sessionId, requestId }`

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
- **First dialog answer dismisses other copies.** The user confirmed the brainstorm behavior during test review. The protocol had no dismissal event, so `extension_ui_resolved` is a new wire addition.
- **Late joiner waits for the final bash result.** The owner accepted this. Partial output stays unavailable to late joiners.
- **Claim work stays in `WsHandler.claimSession`.** Decided during implementation planning. The WS tests drive open, reset, and panel resync through a mocked manager, so the claim work must run in the handler. `attachObserver` only maintains the map. Pending UI replay goes to the attaching observer only. A replay through `sendSlotEvent` would duplicate open dialogs on every other observer.
- **`close_session` ends the session for every observer.** Decided during implementation planning. Close disposes the runtime and sends `session_closed` to every observer. Reason: close ends the session for every observer, as archive does.
- **`call_end` routes `call_ended` to the holder.** Decided during implementation planning. The handler reads `VoiceOrchestrator.callHolder` before it ends the call. This keeps the single-holder model.
- **Re-key collision closes the evicted slot with `replaced`.** When `switchSession` evicts a live slot, each observer of that slot receives `session_closed { reason: 'replaced' }`. The owner previously received `displaced`.
- **Archived sessions leave the persisted restore set.** The web registry keeps the in-memory transcript but marks the session non-restorable. Boot then stops sending the rejected open.
- **`notifyCallEnded` stays beside `notifyClientCallEnded`.** `voice-orchestrator.test.ts` asserts the session-scoped hook. Production wires only `notifyClientCallEnded`.
- **`SessionStateChangedEvent.connectedClientId` stays, always `null`.** The architecture does not list it for removal.

## Open items

### Fog (carried from the brainstorm)

- **Abort and partial output.** Abort goes through `runtime.dispose()`. Whether a partial assistant turn persists, and what observers see, is still unchecked.
- **Narrowing conflict detection.** It needs pi to expose the open session, through a lock or a command-line argument. Neither exists today.
- **Voice call visibility on observers.** The call holder is one client. Whether other observers see the call state is unsettled.

### Sharp (for implementation)

- **Call sites.** `slot.connection` appears in about 25 places across `ws-handler.ts`, `session-manager.ts`, `server.ts`, `index.ts`, and `voice-orchestrator-boot.ts`. Each one needs the observer or call-holder replacement above.
- **Session-closed reason `archived`.** Clients must handle it. The Android mirror also needs it.
- **Manual-test plan.** TP-11 and TP-12 describe takeover and displacement and will fail as written.

## Tests

**Pre-test-write commit:** `320dc57d3484a81477926c5c546ca01797a47a98`

### Interface Files

- `server/src/session-manager.ts` — materializes `SessionObserver`, per-slot observer maps, observer attach/detach seams, and the fan-out stub.
- `server/src/voice-orchestrator.ts` — materializes the per-session `callHolder` map and client-id bind seam.
- `shared/src/protocol.ts` — removes session ownership fields and adds `session_archived` / `archived` wire vocabulary.
- `client/src/lib/stores/connection.svelte.ts` — removes the session ownership callback from restore handling.
- `client/src/lib/stores/session-registry.svelte.ts` — removes takeover and remote-session state and uses plain opens.
- `client/src/lib/stores/folder-store.svelte.ts` — removes ownership enrichment from session rows.
- `client/src/lib/stores/voice-call-store.ts` — removes session-level displacement handling.
- `client/src/lib/components/SessionItem.svelte` — removes remote-owner presentation.
- `client/src/routes/sessions/[sessionId]/+page.svelte` — removes the takeover banner and force-open route.
- `mobile/android/app/src/main/kotlin/com/pimote/android/protocol/Protocol.kt` — hard-cuts ownership fields and session-level displacement from the Android mirror.
- `mobile/android/app/src/main/kotlin/com/pimote/android/call/CallController.kt` — removes the session-level displacement wait branch.

### Test Files

- `server/src/session-observers.test.ts` — tests observer fan-out, cursor handling, replacement, and detach behavior.
- `server/src/voice-call-holder.test.ts` — tests single-holder voice binding, forced transfer, and holder cleanup.
- `client/src/lib/stores/session-registry.test.ts` — removes takeover and remote-session assertions and adds archived-open restore cleanup coverage.
- `client/src/lib/stores/connection.svelte.test.ts` — updates restore rejection coverage for the ownership hard cut.
- `client/src/lib/components/FolderList.test.ts` — removes remote-owner session presentation coverage.
- `client/src/lib/stores/folder-store.svelte.test.ts` — removes ownership enrichment assertions.
- `mobile/android/app/src/test/kotlin/com/pimote/android/protocol/ProtocolJsonTest.kt` — updates session-close reason coverage for `archived`.
- `mobile/android/app/src/test/kotlin/com/pimote/android/call/CallControllerTest.kt` — removes session-level displacement coverage; call-level displacement remains covered.

### Removed Legacy Tests

- `server/src/voice-orchestrator-boot.test.ts` — deleted because it asserted force-bind transfer through the removed session owner and `slot.connection`; holder transfer is covered by `server/src/voice-call-holder.test.ts`.
- `server/src/voice-orchestrator.test.ts` — initially deleted because bind cases used `ClientConnection`. Test review restored its lifecycle/error/bus tests through `clientId`. Only obsolete owner-displacement assertions stay removed, replaced by targeted call-holder transfer coverage.
- `server/src/ws-handler.test.ts` ownership cases — removed silent rebind, `session_owned` rejection, force takeover, remote-session conflict, ownership enrichment, and displaced collision assertions; observer fan-out and replacement are covered by `server/src/session-observers.test.ts`, while archived open behavior is covered by the remaining archived-session test.
- `mobile/android/app/src/test/kotlin/com/pimote/android/call/CallControllerTest.kt` session-level displacement cases — removed because the Android mirror no longer accepts the session-level `displaced` reason; call-level `displaced` coverage remains.

### Behaviors Covered

#### Session observers

- A buffered event reaches every open observer and advances each observer's cursor independently.
- An ephemeral event reaches every observer without advancing read cursors.
- A closed observer socket is skipped without removing other observers.
- A second socket with the same client id replaces the prior observer.
- Detaching one client leaves all other observers attached.

#### Voice call holder

- The first caller becomes the holder for a session.
- A second caller without `force` is rejected while the first holder remains active.
- Forced binding transfers the holder, and ending the call clears it.

#### Archived-session restore

- A `session_archived` open rejection removes the session from the local restore set without deleting its local transcript.

#### Wire and client ownership removal

- Session list and folder rows no longer carry ownership flags.
- Session conflict events no longer carry remote-session records.
- Android no longer sends `open_session.force` or reacts to session-level displacement.

### Red Gate

- `server/src/session-observers.test.ts` contains six tests. Fan-out, attach/detach, and observer reaper lifecycle fail through explicit `not implemented` seams.
- `server/src/voice-call-holder.test.ts` runs three tests and all three fail through the explicit `not implemented` bind seam.
- The archived-session restore test in `client/src/lib/stores/session-registry.test.ts` fails because restore-set cleanup is not implemented yet.
- Server TypeScript compilation and client checking remain green. Android test compilation was green at test-write and was not rerun during review. Implementation behavior stays absent.

### Test-review additions

- `server/src/ws-handler.test.ts` adds two-client open, independent replay/eviction, either-observer prompts, disconnect cleanup, archive close fan-out, explicit unarchive staying closed, and dialog broadcast/first-answer/dismissal cases. The folderless archived open now rejects without clearing the flag.
- `server/src/session-observers.test.ts` uses normal manager creation with mocked runtime dependencies, then public open/getSlot/attach/detach seams. It adds final-observer reaper protection and runtime disposal coverage.
- `server/src/session-manager.test.ts` migrates reaper fixtures and expectations to observer maps. Legacy connection callbacks do not override map presence.
- `server/src/voice-orchestrator.test.ts` restores session-not-found, disabled configuration, bus activation and response, shutdown, idempotent end, and extension-deactivation/no-loop cases.
- `server/src/voice-call-holder.test.ts` checks targeted displaced call notification without session closure.
- `client/src/lib/stores/connection.svelte.test.ts` adds boot/reconnect archived rejection and archive notification restore cleanup. Opens carry no force field.
- `client/src/lib/stores/session-registry.test.ts` checks transcript contents survive archived open rejection.
- `client/src/lib/stores/extension-ui-queue.svelte.test.ts` checks matching dialog dismissal, session isolation, and unknown request IDs.
- `shared/src/protocol.ts` materializes `ExtensionUiResolvedEvent` and adds it to the event union.

### Review verification

- Shared build, server TypeScript compilation, and client checking passed.
- Targeted server run: 68 failed, 100 passed across five files, including migrated reaper tests. Failures include observer stubs and existing WS lifecycle paths removed in test-write.
- Targeted client run: 6 failed, 112 passed. New restore cleanup and dialog dismissal tests fail on missing behavior. An existing cold-boot notification adoption test also fails.
- The review adds behavioral tests, not implementations. Previously green unchanged lifecycle cases remain permitted to pass.

**Review status:** approved

## Steps

**Pre-implementation commit:** `e162a2e6f4140f1aecd88f3b3d6ccc1c6991f892`

### Step 1: Repair blocking test fixtures

The parent approved fixture-only repairs. Do not change any assertion. Each fixture below blocks its tests whatever the implementation does. Code reading established each cause. Nobody ran the tests.

1. `server/src/ws-handler.test.ts`, `createMockSessionManager`. Cause: `attachObserver`, `detachObserver`, and `applySessionReset` throw `not implemented`. Only `pair()` overrides attach and detach. Every other open, cleanup, reset, tree-navigation, fork, and panel-resync test runs on the throwing stubs. Repair:
   - `attachObserver(id, observer)` sets `observer` in `sessions.get(id)?.observers` under `observer.clientId`.
   - `detachObserver(id, clientId)` deletes `clientId` from `sessions.get(id)?.observers`.
   - `applySessionReset(slot)` mirrors the production method from Step 2. If the IDs match, it awaits `onSessionReset(slot, { kind: 'unchanged' })` for each observer. Otherwise it calls `manager.rebuildSessionState(slot)`, evicts a colliding occupant through `manager.onSlotEvicted?.(newId)` and `manager.closeSession(newId)`, calls `manager.reKeySession(slot, oldId, newId)`, and awaits `onSessionReset(slot, { kind: 'rekeyed', oldId, newId, folderPath: slot.folderPath })` for each observer. Snapshot `slot.observers.values()` before the loop. Dispatch through `manager` so per-test overrides apply, as the pre-test-write mock at `320dc57` did.
2. `server/src/ws-handler.test.ts`, `describe('call_end')`. Cause: the mock orchestrator `{ endCall, isCallActive }` has no `callHolder`. Holder routing (Decisions) reads it. Repair: add `callHolder: new Map([['call-session', 'A']])` to that mock.
3. `server/src/session-observers.test.ts`, the `@earendil-works/pi-coding-agent` mock. Cause: the mocked `createAgentSessionRuntime` ignores its factory. `eventBusRef.current` stays `null`, so `openSession` throws in `setupSlotPanelListeners` before any lifecycle assertion. Repair: make the runtime mock invoke the factory argument, so the factory's `createEventBus()` call fills `eventBusRef`. Add mocks for `createAgentSessionServices` and `createAgentSessionFromServices` that return the same fake session. The returned runtime must keep `dispose` as a `vi.fn`.
4. `server/src/voice-call-holder.test.ts`, `createOrchestrator`. Cause: `getEventBus: () => ({})` has no `on` or `emit`. `bindCall` must subscribe and emit activate, as `voice-orchestrator.test.ts` asserts. `endCall` must emit deactivate. Repair: return a bus stub with `on: () => () => {}`, `emit: vi.fn()`, and `clear: vi.fn()`.

**Verify:** `git diff -- '*.test.ts'` shows changes only inside these four fixtures. Server TypeScript compilation (`tsc --noEmit -p server/tsconfig.json`) passes.
**Status:** done

### Step 2: Session manager observer core

File: `server/src/session-manager.ts`.

- `sendSlotEvent(slot, event, options?: { exceptClientId?: string }): void`. Iterate `slot.observers.values()`. Skip the observer whose `clientId` equals `exceptClientId`. Skip an observer whose `ws` is missing or whose `readyState !== 1`. Send `JSON.stringify(event)` inside a try/catch that ignores send errors. After a successful send, set `observer.cursor = event.cursor` when `event` has a numeric `cursor`. Never remove map entries here.
- `resolveSlotPendingUi(slot, requestId, value): boolean`. Return `true` only when a pending entry existed and was resolved.
- `replaySlotPendingUiRequests(slot, send: (event: PimoteEvent) => void): void`. Send each pending request event through `send`, not through `sendSlotEvent`.
- `PimoteSessionManager.attachObserver(sessionId, observer): Promise<void>`. Look up the slot. Throw `Session not found: <id>` if it is missing. Otherwise call `slot.observers.set(observer.clientId, observer)`. A same-`clientId` entry is replaced. Do no claim work.
- `PimoteSessionManager.detachObserver(sessionId, clientId): void`. Delete the entry when the slot exists. Do nothing otherwise.
- `applySessionReset(slot)`. Restore observer notification. For the unchanged path, await `observer.onSessionReset?.(slot, { kind: 'unchanged' })` for each observer. After `reKeySession`, await `observer.onSessionReset?.(slot, { kind: 'rekeyed', oldId, newId, folderPath: slot.folderPath })` for each observer. Notify in sequence over a snapshot array, in map insertion order.
- `startIdleCheck(idleTimeout, _isClientConnected?)`. Restore the `320dc57` body and the `askActivity` import from `@pimote/sdk/activity`. Replace the connected-client test with `slot.observers.size > 0`. Ignore the optional callback. Keep it in the signature only because `session-manager.test.ts` still passes it. The git-branch poll filters slots with `slot.observers.size > 0`.
- Update the `onSlotEvicted` doc comment: consumers notify every observer of the evicted slot.

**Verify:** `server/src/session-observers.test.ts` passes all six tests. `server/src/session-manager.test.ts`, `server/src/session-manager-open-session.test.ts`, and `server/src/extension-ui-bridge.test.ts` pass.
**Status:** done

### Step 3: Voice call holder

Files: `server/src/voice-orchestrator.ts`, `server/src/voice-orchestrator-boot.ts`, `server/src/index.ts`.

- `VoiceOrchestrator.bindCall({ sessionId, clientId, force })`:
  1. Throw `call_bind_failed_session_not_found` when `busResolver.getSlot` returns null.
  2. Throw `call_bind_failed_owned` when a call is active and `force` is false.
  3. Throw `call_bind_failed_internal` when a speechmux URL or the bus is missing. Use the same messages as the `320dc57` body.
  4. When a call is active and `force` is true, read the old holder. Run the existing end path (unsubscribe, emit `pimote:voice:deactivate`). If the old holder differs from `clientId`, call `notifyClientCallEnded?.(oldHolder, { type: 'call_ended', sessionId, reason: 'displaced' })`.
  5. Subscribe to `pimote:voice:deactivate`. Add to `activeCalls`. Set `callHolder.set(sessionId, clientId)`. Emit `pimote:voice:activate`. Return `{ sessionId, webrtcSignalUrl }`.
- `endCall` deletes `callHolder` for the session. It never notifies a client. Callers route `call_ended`.
- `handleExtensionDeactivated` reads the holder, clears `activeCalls`, the unsubscribe entry, and `callHolder`. It then calls `notifyClientCallEnded?.(holder, { type: 'call_ended', sessionId, reason: 'error' })` when a holder existed. It also calls `notifyCallEnded?.(sessionId)`.
- `stop()` clears `callHolder`.
- `voice-orchestrator-boot.ts`: wire `notifyClientCallEnded: (clientId, event) => clientRegistry.get(clientId)?.sendToClient(event)`. Do not wire `notifyCallEnded`. Remove the stale `sendDisplacedEvent` doc comment.
- `index.ts` `onBeforeSessionClose`: read `orchestrator.callHolder.get(sessionId)` before `endCall`. After it, call `server.clientRegistry.get(holder)?.sendCallEndedEvent(sessionId, 'server_ended')`. Change `startIdleCheck` to `sessionManager.startIdleCheck(config.idleTimeout)`. Update the comment that mentions ownership.

**Verify:** `server/src/voice-call-holder.test.ts` and `server/src/voice-orchestrator.test.ts` pass. `server/src/index.test.ts` passes.
**Status:** done

### Step 4: WsHandler attach, sync, reset, and detach

File: `server/src/ws-handler.ts`. Restore the imports test-write removed: `createExtensionUIBridge`, `replaySlotPendingUiRequests`, `requestSlotPanelResync`, and the restore event types.

- `private async claimSession(sessionId, slot)`. Build `SessionObserver { clientId: this.clientId, ws: this.ws, cursor: slot.sessionState.eventBuffer.currentCursor, onSessionReset: (s, o) => this.handleSessionReset(s, o) }`. Await `this.sessionManager.attachObserver(sessionId, observer)`. Add `sessionId` to `subscribedSessions`. When `!slot.sessionState.extensionsBound`, bind extensions as the `320dc57` body did and set the flag. Call `replaySlotPendingUiRequests(slot, (e) => this.sendEvent(e))`. Send the silent download snapshot. Call `requestSlotPanelResync(slot, 'claim')`. Do not touch `idleSince`.
- `private async syncSessionToClient(...)`. Restore the `320dc57` body unchanged: incremental replay or full resync, claim, catch-up from the pre-claim cursor, panel snapshot after replay, and restore started and completed events.
- `private async handleSessionReset(slot, outcome)`:
  - `unchanged`: send the full resync and the download snapshot to this client.
  - `rekeyed`, per observer: move `oldId` to `newId` in `subscribedSessions` and `viewedSessionId`. Send `session_replaced` with `resolveFolderInfo(folderPath)`. Send the download snapshot.
  - `rekeyed`, slot-wide work runs only when this client is the first key of `slot.observers`. That observer rebinds extensions (bridge `isVoiceModeActive` reads `newId`), sets `extensionsBound`, calls `requestSlotPanelResync(slot, 'reset')`, and broadcasts sidebar updates for `oldId` and `newId`. Order: rebind, `session_replaced`, snapshot, panel resync, sidebar broadcasts. The rule binds once per reset. `bindExtensions` emits `session_start` on each call.
- `emitBufferedSessionEvent`: keep `this.sendEvent(event)` to the issuer, and add `sendSlotEvent(slot, event, { exceptClientId: this.clientId })`. Tree-navigation events then reach every other observer. The issuer receives the event directly because the tree-navigation tests issue `navigate_tree` without an open. Their mock observer has no socket.
- `cleanup()`: call `this.sessionManager.detachObserver(sid, this.clientId)` for each subscribed session. Remove the try/catch.
- Delete `displaceOwner` and `sendDisplacedEvent`. Update the `ClientRegistry`, `createCommandContextActions`, and `server.ts` claim comments to observer terms.

**Verify:** In `server/src/ws-handler.test.ts`, these pass: the "observer command boundary" open, replay, and prompt tests; "open_session — same client ID", "catch-up replay", "disk-backed reopen", "cleanup", "handleSessionReset", "tree navigation interfaces", "fork command", and "panel resync requests".
**Status:** done

### Step 5: Open, archive, close, kill, delete, and eviction

Files: `server/src/ws-handler.ts`, `server/src/server.ts`.

- Replace `sendKilledEvent` with `sendSessionClosedEvent(sessionId: string, reason?: SessionClosedEvent['reason']): void`. It deletes `sessionId` from `subscribedSessions`, clears `viewedSessionId` on a match, and sends `session_closed` with the reason when present.
- Add `private async closeSessionForObservers(sessionId, slot, reason?)`. Snapshot the observer client IDs. Call `this.clientRegistry.get(id)?.sendSessionClosedEvent(sessionId, reason)` for each. Call `resolveAllSlotPendingUi(slot)`. Await `this.sessionManager.closeSession(sessionId)`. Route through handlers, not `sendSlotEvent`, so each handler drops its own subscription.
- `open_session` rejects archived sessions with `session_archived` before it opens anything or runs hooks. Live path: check `existing.session.sessionFile`. Disk and folderless paths: check `record.sessionFilePath` before `runOpenHooks`. Clear nothing. Update the `findSessionRecord` comment that says opening unarchives.
- `archive_session` with `archived: true`: for each live slot, await `closeSessionForObservers(id, slot, 'archived')` before `setArchived(path, true)` and the broadcast. With `archived: false`: set the flag and broadcast only. Never close or open.
- `close_session`: when the slot exists, call `closeSessionForObservers(id, slot)` with no reason. If this client was not an observer, or the slot was missing, call `this.sendSessionClosedEvent(id)`.
- `kill_conflicting_sessions`: call `closeSessionForObservers(id, slot, 'killed')` per live slot.
- `delete_session`: replace the bare close with `closeSessionForObservers(id, slot, 'killed')`.
- `server.ts` `onSlotEvicted`: for each observer client ID of `sessionManager.getSlot(sessionId)`, call `clientRegistry.get(id)?.sendSessionClosedEvent(sessionId, 'replaced')`.

**Verify:** In `server/src/ws-handler.test.ts`, these pass: "archives every live slot", "kill_conflicting_sessions", "archive_session and archived listings", and "folderless deep-link reopen". `server/src/server.test.ts` passes.
**Status:** done

### Step 6: Dialog resolution and call_end routing

File: `server/src/ws-handler.ts`.

- `extension_ui_response`: when `resolveSlotPendingUi` returns `true`, call `sendSlotEvent(uiSlot, { type: 'extension_ui_resolved', sessionId, requestId }, { exceptClientId: this.clientId })`. A later answer for the same ID resolves nothing and sends nothing. Always respond success, as today.
- `call_end`: read `holder = this.voiceOrchestrator?.callHolder.get(sessionId)` before `endCall`. After the response, send `call_ended { reason: 'user_hangup' }` to `this.clientRegistry.get(holder)`, or to this handler when no holder handler exists.

**Verify:** In `server/src/ws-handler.test.ts`, "broadcasts a dialog and accepts only its first answer" and "call_end" pass. The full `server/src/ws-handler.test.ts` passes.
**Status:** done

### Step 7: Web connection store archived handling

File: `client/src/lib/stores/connection.svelte.ts`.

- Add `onSessionArchived: ((sessionId: string) => void) | null = null`.
- Restore loop: when `response.error === 'session_archived'`, call `removeSubscribedSession(sessionId)` and `onSessionArchived?.(sessionId)`. Do not call `onSessionNotFound`. The restore still counts as settled, so `ready` becomes `true`.
- `onmessage`: before listener dispatch, when `event.type === 'session_archived' && event.archived`, call `removeSubscribedSession(event.sessionId)` and `onSessionArchived?.(event.sessionId)`. Ignore `archived: false`.

**Verify:** `client/src/lib/stores/connection.svelte.test.ts` passes, including the boot and reconnect archived rejection and the archive notification tests.
**Status:** done

### Step 8: Web registry archived restore

File: `client/src/lib/stores/session-registry.svelte.ts`.

- Add `restorable: boolean` to `PerSessionState`. Default it to `true` in `createSessionState`.
- Add `setRestorable(sessionId: string, restorable: boolean): void`. It sets the flag on an existing entry and calls `persistSessions()`. `persistSessions` keeps only entries with `restorable`.
- `openExistingSession`: on `session_archived`, call `connection.removeSubscribedSession(sessionId)`. If the session was already tracked, call `setRestorable(sessionId, false)` and keep its transcript. Otherwise call `dropSession`. Return `false`. On success, call `setRestorable(sessionId, true)`.
- Wire `connection.onSessionArchived = (id) => sessionRegistry.setRestorable(id, false)`.
- The `session_closed` handler already removes the entry for every reason, including `archived`. Leave it.

Cause of the failing cold-boot adoption test: the archived-open test leaves `s-archived` in `connection.subscribedSessions`, and its `afterEach` does not remove it. The cold-boot connect then waits forever on that restore, so `onPendingAdopt` never fires. This step removes the entry, which fixes the test.

**Verify:** `client/src/lib/stores/session-registry.test.ts` passes, including "an archived open drops the session" and "cold-boot notification adoption".
**Status:** done

### Step 9: Web dialog dismissal

File: `client/src/lib/stores/extension-ui-queue.svelte.ts`. In the `connection.onEvent` listener, on `extension_ui_resolved`, remove only the queue entry that matches both `sessionId` and `requestId`. Unknown IDs change nothing.

**Verify:** `client/src/lib/stores/extension-ui-queue.svelte.test.ts` passes. `npm run check --workspace=client` passes.
**Status:** not started

### Step 10: Manual-test documentation

- `docs/MANUAL-TEST-PLAN.md`:
  - Replace TC-11.08 to TC-11.11 with observer cases: two tabs open one session; both see live events; either tab sends; disconnecting one tab leaves the other attached; an archived session rejects reconnect with `session_archived` and leaves the restore set.
  - Remove TC-12.01a, TC-12.06, and TC-12.07. Remote-session conflict no longer exists.
  - Add archive cases: archive closes every observer with `reason: 'archived'`, and unarchive leaves the session closed.
  - Add a dialog case: the first answer wins, and other tabs close their copy.
  - Remove the `isOwnedByMe` lines near TC list rows (around lines 335 and 349) and in TC-20.03. Rewrite known-issue item 10, which describes takeover races.
- `tools/manual-test/PLAN.md`: rewrite journey 4 as shared observers (two clients, live transcript, either sends, archive closes both). Keep the call-level `call_ended { reason: 'displaced' }` text in the voice journey.

**Verify:** `rg -n "isOwnedByMe|session_owned|pendingTakeover|remoteSessions|Take Over" docs/MANUAL-TEST-PLAN.md tools/manual-test/PLAN.md` returns nothing.
**Status:** not started

### Step 11: Full verification

Run `npm run build:shared`, `npm run check` (client check plus server and shared `tsc`), `npx vitest run` in `server/` and `client/`, and `make android-test`. Remaining source references must be legitimate call-level voice vocabulary only.

**Verify:** All commands pass. `rg -n "isOwnedByMe|session_owned|pendingTakeover|remoteSessions|claimSession\(.*force|sendDisplacedEvent|slot\.connection|connectedClientId ===" server/src client/src shared/src` returns no production hits.
**Status:** not started
