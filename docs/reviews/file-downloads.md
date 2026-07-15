# Review: File Downloads

**Plan:** `docs/plans/file-downloads.md`
**Diff range:** `1ae92c102105a0a8359fd5fd6fd29985c5823574..c672594a8238275dfc3a667eaede9c358cf8adba`
**Date:** 2026-07-15

## Summary

The twelve file-download steps are represented in the implementation, and the plan-listed test files remained immutable after the implementation baseline. However, the reviewed commit also contains an unrelated idle-boundary refactor, and the clean commit does not type-check against its committed SDK version; several runtime correctness issues remain around persistence GC, live-file streaming, notification delivery, and stale UI state.

## Findings

### 1. Committed HEAD does not build against its pinned SDK and wire types

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/session-manager.ts:250-270`; `server/src/ws-handler.ts:121-129`; `client/src/lib/stores/session-registry.svelte.ts:240-253`; `server/src/event-buffer.ts:268-281`; `shared/src/protocol.ts:620-634`
- **Status:** open

The reviewed code consumes the SDK 0.80.7 `agent_settled` event and `AgentSession.waitForIdle()`, while the committed lockfile installs 0.80.3. The shared protocol and event buffer also do not define a corresponding `agent_settled` wire event. In a clean checkout, type checking reports that the event is outside the SDK event union, `waitForIdle` is missing, and the client event is not a `PimoteEvent`; if type checking is bypassed, SDK 0.80.3 never emits the event, so completion pushes, attention state, and idle reaping can stop running.

### 2. Unrelated idle-boundary and reload changes are mixed into this feature

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/session-manager.ts:250-273`; `client/src/lib/stores/session-registry.svelte.ts:240-264`; `server/src/ws-handler.ts:123-129, 849-855`
- **Status:** open

The diff changes completion/idle transitions and push/reaping from `agent_end` to `agent_settled`, replaces the existing idle wait with an SDK primitive, and changes `/reload` to await and send a full resync. None of these changes is part of the file-download plan, so they expand the review scope and introduce unrelated behavior and compatibility risk into the feature commit.

### 3. Partial folder enumeration can make boot GC delete valid session state

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/index.ts:42-62`; `server/src/folder-index.ts:24-34, 65-71`
- **Status:** resolved

Boot relies on an exception to turn the GC allow-list into `null`, but `FolderIndex.scan()` skips inaccessible roots and `listSessionRecords()` converts failures into an empty list. A transiently unavailable root can therefore produce a partial or empty non-null allow-list; static-host and download GC then classify omitted sessions as orphans and delete their persisted registrations. The safety contract requires skipping GC whenever session enumeration is not complete.

### 4. Click-time validation can be bypassed by replacing the source path before opening

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/file-download/source.ts:43-62`; `server/src/file-download/http-handler.ts:94-111`
- **Status:** resolved

The route validates and stats a pathname, then passes that pathname to `createReadStream`. A process with write access to the workspace can replace the file with a symlink between those operations; the stream follows the replacement target, which may be outside the captured workspace. This defeats the route's real-path containment guarantee and can expose an unintended file.

### 5. Consumed or revoked registrations leave stale actionable toasts

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/download-coordinator.ts:13-15`; `client/src/lib/stores/download-ui.svelte.ts:19-26`; `client/src/lib/stores/session-registry.svelte.ts:521-528`
- **Status:** resolved

Only `offered` updates reach the download UI store. `consumed`, `revoked`, full-resync, and session-removal updates do not prune the toast queue, so a toast can continue showing a one-shot link after another browser downloaded it, the agent cancelled it, or the session was replaced. Clicking the stale action then produces a dead capability/404 instead of removing the obsolete prompt.

### 6. Focused-client push suppression can lose the only offer notification during reconnect

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/sw.ts:140-155`
- **Status:** resolved

Every focused client maps a download push to `{ kind: 'none' }`, without checking whether its WebSocket is connected and subscribed. If the focused PWA is reconnecting when the offer occurs, the live `download_update` may never arrive, while reconnection supplies only a silent `restored` snapshot. The user then receives neither the actionable toast nor an OS notification.

### 7. Notification adoption is dropped when an existing window is reconnecting

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/routes/+layout.svelte:129-137`; `client/src/lib/stores/session-registry.svelte.ts:768-780, 794-846`
- **Status:** resolved

Cold-start notification intents use `connection.pendingAdopt`, but service-worker click messages route through `routeNotificationIntent()` immediately. When the owning session is inactive and the WebSocket is closed or reconnecting, `openExistingSession()` rejects, removes the newly added session, and does not queue the inbox request for the next successful connection. The notification click therefore appears to do nothing.

## No Issues

Plan adherence: all twelve planned steps and their listed interfaces are represented, and no plan-listed test files were modified after the implementation baseline. The remaining findings above are the scope and correctness issues identified by the two review passes.
