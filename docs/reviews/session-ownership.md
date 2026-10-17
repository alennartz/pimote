# Review: Session ownership

**Plan:** `docs/plans/session-ownership.md`
**Diff range:** `320dc57d3484a81477926c5c546ca01797a47a98..f3d26ee`
**Date:** 2026-10-17

## Summary

The implementation removes session ownership and adds multi-observer fan-out across the server, clients, and wire protocol. The test files remained immutable after the pre-implementation commit, but the review found one blocked client workflow and several observer, archive, cursor, and lifecycle gaps. These issues need correction before the redesign is complete.

## Findings

### 1. Archived transcripts cannot be reopened after unarchive

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `client/src/lib/stores/session-registry.svelte.ts:893-895`, `client/src/lib/components/SessionItem.svelte:46-53`, `client/src/lib/session-route.ts:39-51`
- **Status:** open
- **Fix:** Treat `restorable === false` entries as inactive so a row click and route load call `openExistingSession`.

An archived open rejection keeps the transcript in `sessionRegistry.sessions` and marks it `restorable = false`. `isActiveSession()` only checks map membership, so the session row and route treat the closed transcript as live. After unarchiving, a click only switches to the transcript and never sends `open_session`; the session stays closed until a page reload.

### 2. Manager-tool archive omits the required close event

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/index.ts:179-199`
- **Status:** open
- **Fix:** Route manager-tool archive through the same observer close operation that sends `session_closed { reason: 'archived' }` and resolves pending UI.

`archiveSessions()` sets the metadata flag, calls `sessionManager.closeSession()` directly, and broadcasts only `session_archived`. Live observers never receive `session_closed` with reason `archived`, and their pending dialogs and local session entries are not closed through the normal observer path. This violates the plan's requirement that every archive entry point close every live observer.

### 3. Bash deltas still carry and advance replay cursors

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `shared/src/protocol.ts:1028-1035`, `server/src/event-buffer.ts:320-326`, `server/src/session-manager.ts:100-106`
- **Status:** open
- **Fix:** Give live bash updates a non-cursor wire shape and keep them out of observer cursor advancement.

`BashExecutionUpdateEvent` extends `SessionEventBase`, and `event-buffer.ts` spreads the cursor-bearing base into every delta. `sendSlotEvent()` therefore advances each observer's cursor for output that the plan explicitly defines as ephemeral. High-volume bash output can create artificial cursor gaps and force unnecessary full resyncs for reconnecting observers.

### 4. A closed socket can attach after cleanup and pin a session forever

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1463-1471`, `server/src/ws-handler.ts:1911-1922`, `server/src/session-manager.ts:806-826`
- **Status:** open
- **Fix:** Reject an attach when this handler is no longer the current client-registry entry or its socket is not open.

A slow `open_session` or folder hook can outlive the socket. `cleanup()` detaches the sessions known at that moment, then the late `claimSession()` call adds the dead socket to `slot.observers`. `sendSlotEvent()` skips the closed socket but retains the map entry, while the reaper checks only `observers.size`. The session and branch poll remain protected until restart. A late attach from a replaced socket can also overwrite the replacement observer with the same `clientId`.

### 5. Reset can bind extensions twice

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1504-1525`
- **Status:** open
- **Fix:** Capture the first observer once before awaiting callbacks, or move slot-wide reset work into a manager-level once-per-reset hook.

`handleSessionReset()` decides whether to run slot-wide work by reading the current first map key, then awaits `bindExtensions()`. If that observer disconnects during the await, the next callback sees itself as first and binds the rebuilt session again. This can emit duplicate `session_start` events and duplicate panel resyncs, contrary to the plan's bind-once rule.

### 6. Active voice calls are not protected from idle reaping

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/session-manager.ts:815-826`, `server/src/ws-handler.ts:710-739`, `mobile/android/app/src/main/kotlin/com/pimote/android/call/CallController.kt:490-526`
- **Status:** open
- **Fix:** Make the reaper treat an active call holder as activity, or attach the call holder as an observer for the call lifetime.

The reaper protects only `slot.observers.size > 0`. Android's existing-session call path sends `call_bind` without `open_session`, so a call holder can exist with no observer. An idle session then gets disposed after the timeout, and `onBeforeSessionClose` ends the active call. A live voice call must not be reaped merely because its audio client is not a transcript observer.

### 7. Archive close has a reopen window

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:628-634`, `server/src/ws-handler.ts:1646-1653`, `server/src/session-manager.ts:660-678`
- **Status:** open
- **Fix:** Serialize opens with archive close, or mark the session as closing/archived before awaiting runtime disposal.

The WebSocket archive path notifies and awaits `closeSessionForObservers()` before writing the archived flag. `closeSession()` leaves the slot in the session map while `runtime.dispose()` awaits. Another client can open that live slot during this window, receive a successful attach, and then lose it when disposal completes without receiving a close event. A disk reopen can also pass the archive check before the flag is written.

### 8. Session settings changes reach only the issuing observer

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1184-1247`, `server/src/event-buffer.ts:313-318`
- **Status:** open
- **Fix:** Fan out a state update or full resync after model, thinking-level, auto-compaction, and reload mutations.

`set_model`, `cycle_model`, `set_thinking_level`, and `set_auto_compaction` return the new state only in the requester's response. The corresponding SDK `session_info_changed` and `thinking_level_changed` events are dropped, so other observers keep stale model and composer settings until a later reconnect or full resync. The same issuer-only behavior affects `/reload` command and panel state visibility.

### 9. Pending dialogs can remain open after timeout or abort

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/extension-ui-bridge.ts:69-106`, `server/src/session-manager.ts:219-225`, `server/src/ws-handler.ts:1084-1095`
- **Status:** open
- **Fix:** Emit a matching dismissal event to every observer whenever a pending UI request is resolved by timeout, abort, or bulk cleanup.

The first explicit response broadcasts `extension_ui_resolved`, but timeout and abort paths only delete or resolve the server-side pending entry. Other observers retain the dialog in their queue. A later answer is ignored because no pending entry remains, leaving those copies stuck indefinitely.

### 10. The manual test still specifies the old disconnect behavior

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `docs/MANUAL-TEST-PLAN.md:1146-1149`
- **Status:** open
- **Fix:** Rewrite TC-13.11 to expect pending-dialog replay after reconnect instead of cleanup resolution.

TC-13.11 says disconnect cleanup resolves all pending UI responses with `undefined`. The plan preserves pending requests on `ManagedSlot` and replays them to a reconnecting observer, while `WsHandler.cleanup()` only detaches the observer. The manual test now directs verification toward behavior the redesign removed.

### 11. Tree-navigation events bypass the issuer's observer cursor

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `server/src/ws-handler.ts:1748-1760`
- **Status:** open
- **Fix:** Update the attached issuer's `SessionObserver.cursor` when delivering its direct tree-navigation event.

`emitBufferedSessionEvent()` sends the issuer's event with `this.sendEvent()` and uses `sendSlotEvent()` only for other observers. An attached issuer therefore receives the event without advancing its observer cursor, while every other observer advances. The unopen-issuer test path explains the direct send but does not cover the attached case.

## Verification

Implementation-time test changes were limited to the approved fixture repairs and mock setup. No test assertions were modified after the pre-implementation commit.
