# Test Review: File Downloads

**Plan:** `docs/plans/file-downloads.md`
**Brainstorm:** `docs/brainstorms/file-downloads.md`
**Date:** 2026-07-15

## Summary

The test contract now covers the brainstorm's live, single-use, session-scoped download behavior at the manager, HTTP, EventBus, recovery, push, and client-presentation boundaries. The architecture gaps found during review were resolved with approved discriminated offer events, durable-claim failure semantics, and an explicit inbox-opening notification intent. Type and lint checks pass; the feature tests remain intentionally red against their test-write stubs until implementation.

## Findings

### 1. Safe in-workspace symlink was treated as an escape

- **Category:** over-specified
- **Severity:** critical
- **Location:** `server/src/file-download/manager.test.ts:58-79, 162-170`
- **Status:** resolved

The fixture linked `reports/linked-secret.txt` to `secret.txt` inside the workspace while the test required rejection. That contradicted the brainstorm and plan, which allow a regular file when its resolved real path remains within the captured workspace. The fixture now links the rejection case outside the workspace, and a separate positive test protects inside-root symlink support.

### 2. Activation and claim tests contradicted the manager lifecycle

- **Category:** over-specified
- **Severity:** critical
- **Location:** `server/src/file-download/manager.test.ts:184-206, 234-261`
- **Status:** resolved

A synchronous `snapshot()` test expected persisted state before `activate()`, although activation is the documented rehydration boundary. The claim-order test also counted activation's required `restored` publication as if it belonged to consumption. The tests now activate first, isolate the consumption publication, and verify actual offer/cancel/claim persistence across a fresh manager instance.

### 3. Filesystem-order assertions could flake

- **Category:** non-deterministic
- **Severity:** warning
- **Location:** `server/src/session-json-store.test.ts:47-117`
- **Status:** resolved

Several GC assertions compared raw `readdir()` output to ordered arrays even though directory enumeration order is not a contract. The tests now sort names before comparing them.

### 4. Agent tool contract exposed the client-only one-shot href

- **Category:** unplanned scope
- **Severity:** warning
- **Location:** `server/src/file-download/tools.ts:7-8`, `server/src/file-download/tools.test.ts:23-37`
- **Status:** resolved

The architecture specifies `{ id, filename, sizeBytes }` for `pimote_send_file`; `href` belongs only in the PWA snapshot. The adapter output and tests now exclude `href`, and the extension test verifies that its tool result does too.

### 5. Traversal test depended on client URL normalization

- **Category:** over-specified
- **Severity:** warning
- **Location:** `server/src/file-download/http-handler.test.ts:198-202`
- **Status:** resolved

`fetch('/d/id/../report.pdf')` normalizes before it reaches the server, so it cannot prove the route sees a two-segment request. The test now uses an encoded slash-bearing segment that survives URL construction. The route suite also gained explicit non-`GET` and live-at-click coverage.

### 6. Full offered snapshots did not identify the item to toast

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `shared/src/protocol.ts:911-928`, `client/src/lib/download-presentation.test.ts:19-51`
- **Status:** resolved

A full snapshot with older pending items gave the client no principled way to know which item caused an `offered` event. Approved resolution: `DownloadUpdateEvent` is now discriminated, and its `offered` variant requires `offeredDownloadId`. Presentation and coordinator tests use multi-item snapshots and toast only that exact item.

### 7. Server-to-client delivery, recovery, boot, and push paths lacked boundary coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/session-manager.test.ts:451-573`, `server/src/ws-handler.test.ts:262-342, 553-581, 1394-1413`, `server/src/index.test.ts:100-142`, `server/src/server.test.ts:27-67`
- **Status:** resolved

The original tests covered isolated manager and route behavior but not the required `pimote:downloads` owner routing, full/incremental recovery, view changes, takeover, reset isolation, factory injection, route mounting, boot GC safety, or VAPID metadata. Approved resolution: narrow server routing/bootstrap seams and component-boundary tests now cover each documented handoff, including no migration across replacement.

### 8. Durable claim-removal failure had no observable contract

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/file-download/manager.test.ts:264-280`, `server/src/file-download/http-handler.test.ts:136-147`
- **Status:** resolved

The plan required no bytes when persistence fails but did not specify how `claim()` or the route reports that failure. Approved resolution: `claim()` rejects, and the route returns a generic `500` without opening the source or exposing an error body. Both manager and HTTP tests enforce it.

### 9. Notification clicks could not express opening the fallback inbox

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/download-push.test.ts:13-30`, `client/src/lib/download-notification-intent.test.ts:25-69`, `client/src/lib/stores/connection.svelte.ts:8-16, 59-61, 169-171`
- **Status:** resolved

Existing notification handling could select or adopt a session but carried no inbox-open intent. Approved resolution: background download pushes carry only `openDownloads: true`, focused pushes plan no duplicate prompt, and the notification coordinator tests switching or awaiting adoption before opening the owning session's inbox without redeeming a link.
