# Review: Per-assistant-message cost

**Plan:** `docs/plans/per-assistant-turn-cost.md`
**Diff range:** `2f8e3045fb397c97b758dfcd0af5a72d845fcd98..af65c435d6160b0c5eeb208a63e6aedd988a412b`
**Date:** 2026-10-23

## Summary

The implementation covers the planned wire, session, row-projection, disclosure, and UI work. The approved feature tests remain immutable, and the plan steps map to the implementation. The abort/error partial-usage fallback does not work with Pi's real zero-usage failure messages, and the range also contains unrelated command-refresh work.

## Findings

### 1. Abort fallback loses real partial usage

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/session-registry.svelte.ts:425-443,591-600,694-700`
- **Status:** open
- **Fix:** Preserve the last positive snapshot across Pi's failure `message_start` and treat an all-zero terminal usage snapshot as unusable.

Pi's `handleRunFailure` emits a failure assistant message with an all-zero `usage` object. The mapper preserves that object, so `message.usage === undefined` is false. Pi emits a new `message_start` before that terminal message, and `resetAssistantUsageTracking` clears the positive streaming snapshot. The client therefore cannot retain partial cost for an aborted or errored stream, although the plan requires it.

### 2. Transient fallback is not limited to the active view

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `client/src/lib/stores/session-registry.svelte.ts:1057-1065`
- **Status:** open
- **Fix:** Apply `assistantUsageOverrides` only when `sessionId === this.viewedSessionId`.

The plan requires terminal partial usage to remain an active-view-only override. `getAssistantRowUsage` applies the override for any session ID, so callers can expose transient data from a background session instead of the persisted transcript.

### 3. Unplanned command-refresh feature is in the review range

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `shared/src/protocol.ts:1302-1307`, `server/src/ws-handler.ts:107-141,2160-2179`, `client/src/lib/stores/session-registry.svelte.ts:1593-1596`
- **Status:** open
- **Fix:** Keep the command-refresh change in a separate review scope, or add it explicitly to this plan.

Commit `92669b5` adds a `session_commands_changed` protocol event and server/client command-cache refresh behavior. The per-assistant-turn-cost plan does not cover this feature. The change is preserved, but it needs separate scope or plan coverage.

### 4. Row projections rescan the full transcript

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/assistant-row-usage.ts:10-18`, `client/src/lib/components/MessageList.svelte:159-174`
- **Status:** open
- **Fix:** Build one `toolCallId` to usage index per transcript snapshot and reuse it for all assistant rows.

The plan calls for indexing tool-result usage by `toolCallId`. The implementation scans every message for every assistant row. Recomputing all rows after each message replacement is O(rows × messages), which can make long transcripts costly to render.

## No Issues

No other significant plan deviations or correctness risks were found in the two review passes. The six approved feature test files are unchanged after the pre-implementation commit, and Android files remain unchanged.
