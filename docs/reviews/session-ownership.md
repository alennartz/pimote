# Review: Session ownership

**Plan:** `docs/plans/session-ownership.md`
**Diff range:** `c1c172c..536dafd`
**Date:** 2026-10-17

## Summary

This re-check covers only the fix commits after the baseline review. All eleven prior findings are resolved, including archive fan-out, observer attach guards, call-aware reaping, cursor handling, settings fan-out, dialog dismissal, and documentation. The fix diff introduces one warning: full-resync fan-out can erase another observer's local transient state.

## Findings

### 1. Archived transcripts cannot be reopened after unarchive

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `client/src/lib/stores/session-registry.svelte.ts:893-895`, `client/src/lib/components/SessionItem.svelte:46-53`, `client/src/lib/session-route.ts:39-51`
- **Status:** resolved
- **Fix:** Treat `restorable === false` entries as inactive so a row click and route load call `openExistingSession`.

`isActiveSession()` now checks `restorable`, and `activeSessions` excludes archived transcripts. A retained archived transcript therefore follows the explicit open path after unarchive instead of only switching views.

### 2. Manager-tool archive omits the required close event

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/index.ts:179-199`, `server/src/ws-handler.ts:201-215`
- **Status:** resolved
- **Fix:** Route manager-tool archive through the same observer close operation that sends `session_closed { reason: 'archived' }` and resolves pending UI.

Manager archive now calls the shared `closeSessionForObservers()` helper. It sends the archived close event, resolves pending dialogs, and then disposes the slot before broadcasting the archive state.

### 3. Bash deltas still carry and advance replay cursors

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `shared/src/protocol.ts:1006-1015`, `server/src/event-buffer.ts:42-76`, `server/src/event-buffer.ts:294-326`
- **Status:** resolved
- **Fix:** Give live bash updates a non-cursor wire shape and keep them out of observer cursor advancement.

Bash updates now use `EphemeralSessionEventBase`, omit the cursor in `mapEvent()`, and leave the replay cursor unchanged. The buffer also rejects non-cursor entries before storage.

### 4. A closed socket can attach after cleanup and pin a session forever

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1492-1530`, `server/src/ws-handler.ts:1532-1546`, `server/src/session-manager.ts:806-826`
- **Status:** resolved
- **Fix:** Reject an attach when this handler is no longer the current client-registry entry or its socket is not open.

`claimSession()` now validates the current handler and open socket before attach, after attach, and after extension binding. It detaches its observer when a connection becomes stale, so a dead observer cannot pin the reaper or replace a reconnecting observer.

### 5. Reset can bind extensions twice

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/session-manager.ts:687-708`, `server/src/ws-handler.ts:1518-1538`
- **Status:** resolved
- **Fix:** Capture the first observer once before awaiting callbacks, or move slot-wide reset work into a manager-level once-per-reset hook.

`applySessionReset()` passes the snapshot index to each callback. `handleSessionReset()` performs the bind only for the captured first observer and only while the rebuilt slot is not already bound. A disconnect during the first await cannot trigger a second bind.

### 6. Active voice calls are not protected from idle reaping

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/session-manager.ts:806-829`, `server/src/index.ts:294-295`
- **Status:** resolved
- **Fix:** Make the reaper treat an active call holder as activity, or attach the call holder as an observer for the call lifetime.

`startIdleCheck()` now accepts an `isCallActive` callback and excludes active calls from reaping. Production wires the callback to `VoiceOrchestrator.isCallActive`, so Android calls without transcript observers remain alive.

### 7. Archive close has a reopen window

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:631-643`, `server/src/index.ts:191-198`
- **Status:** resolved
- **Fix:** Serialize opens with archive close, or mark the session as closing/archived before awaiting runtime disposal.

Both archive entry points now set the metadata flag before runtime disposal. A concurrent open sees `session_archived` instead of attaching to a slot that is closing.

### 8. Session settings changes reach only the issuing observer

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1014-1035`, `server/src/ws-handler.ts:1197-1275`, `server/src/ws-handler.ts:1849-1860`
- **Status:** resolved
- **Fix:** Fan out a state update or full resync after model, thinking-level, auto-compaction, and reload mutations.

Reload and session setting commands now send the current state and panel snapshot to every observer. Other clients no longer wait for reconnect before seeing model and composer changes.

### 9. Pending dialogs can remain open after timeout or abort

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/extension-ui-bridge.ts:63-111`, `server/src/session-manager.ts:219-228`
- **Status:** resolved
- **Fix:** Emit a matching dismissal event to every observer whenever a pending UI request is resolved by timeout, abort, or bulk cleanup.

Timeout and abort paths now resolve the pending entry through `dismissDialog()`. Bulk cleanup captures every request ID, resolves it, and broadcasts `extension_ui_resolved` to all observers.

### 10. The manual test still specifies the old disconnect behavior

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `docs/MANUAL-TEST-PLAN.md:1146-1152`
- **Status:** resolved
- **Fix:** Rewrite TC-13.11 to expect pending-dialog replay after reconnect instead of cleanup resolution.

TC-13.11 now verifies reconnect replay and keeps the extension pending until an observer answers or the request times out.

### 11. Tree-navigation events bypass the issuer's observer cursor

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `server/src/ws-handler.ts:1784-1796`
- **Status:** resolved
- **Fix:** Update the attached issuer's `SessionObserver.cursor` when delivering its direct tree-navigation event.

The direct issuer path now updates the attached observer cursor before fan-out to other observers.

### 12. Full-resync fan-out erases observer-local transient state

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:1849-1860`, `client/src/lib/stores/session-registry.svelte.ts:644-680`
- **Status:** open
- **Fix:** Send a state-only settings event, or preserve each observer's transient queue, optimistic message, and bash state when applying this resync.

The settings fix sends `full_resync` to every observer. The client reducer rebuilds the session and preserves only the draft and a few presentation fields. It resets `pendingSteeringMessages`, `optimisticMessageKey`, `bashExecutions`, `needsAttention`, and other local transient state. If observer B is prompting, steering, or running bash while observer A changes the model, B loses that in-flight UI state even though the session itself did not reset.

## Verification

This was a scoped re-check of `c1c172c..536dafd`; it did not rerun the full-baseline review or the two-pass fan-out. The eleven prior findings above are resolved. The full-resync transient-state regression is the only new issue found in the fix diff.
