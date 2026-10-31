# Review: fork-from-transcript-message

**Plan:** `docs/plans/fork-from-transcript-message.md`
**Diff range:** `d79490ed2436c8f3ce9e38d76bbab8077b6fb7f9..63e570b`
**Date:** 2026-10-31

## Summary

The implementation covers the planned server and client surfaces, but the review found correctness failures in core navigation flows. Deep sessions can hang `get_tree`, branch snapshots stay stale after normal turns, and a resync can cause redo to overwrite a newly typed draft. The diff also changes tests outside the approved exceptions and leaves several UI and documentation mismatches.

## Findings

### 1. Unauthorized test changes violate the immutable-test rule

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `client/src/lib/components/MessageList.bash.test.ts:27-87`; `client/src/lib/conversation-find.test.ts:25-28`
- **Status:** dismissed
- **Fix:** Restore these test files or add explicit exceptions to Step 9 before retaining the changes.

Step 9 permits only the `InputBar.dispatch.test.ts` migration and the retired-suite deletions. The implementation rewrites an existing fork test, changes a conversation-match offset, and still leaves fork wording and a `type: 'fork'` fixture in the rewritten test. Test immutability makes the implementation diff independently reviewable and prevents production changes from weakening or reshaping its contract.

### 2. Direct `get_tree` responses overflow on deep sessions

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/ws-handler.ts:1581-1584`
- **Status:** resolved
- **Fix:** Send `serializeTreeResponse(...)` through `sendSerializedResponse` in the `get_tree` case.

The direct command passes a deeply nested tree to `sendResponse`, which calls recursive `JSON.stringify`. Node 22, a supported runtime, overflows at roughly 3,000 nested entries. The server catches the error without sending a response, so the client's tree load waits forever. The slash-command path already uses the iterative serializer and does not have this failure.

### 3. Redo can overwrite a draft typed after resync

- **Category:** code correctness
- **Severity:** critical
- **Location:** `client/src/lib/components/MessageList.svelte:63-77`
- **Status:** resolved
- **Fix:** Read `sessionRegistry.sessions[sessionId]?.draftText` after navigation resolves, before applying the draft policy.

`handleRedo` captures the viewed session object before `navigate` awaits. Tree navigation emits a full resync that replaces that object. Text typed after the replacement is absent from `viewed.draftText`, so `needsDraftPrompt` can treat an occupied draft as empty and apply `editorText` without asking the user. This can lose user input.

### 4. Branch snapshots stay stale after ordinary turns

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/branch-tree-store.svelte.ts:135-140,381-383`; `client/src/lib/components/MessageList.svelte:192-206`
- **Status:** resolved
- **Fix:** Invalidate the session cache on `agent_end` and expose a reactive cache version that reload effects consume.

The store clears its cache only on `full_resync`. A normal new turn does not invalidate it, and the transcript effect keeps using the cached tree. After a redo creates a new branch, menus and the explorer still see the old continuation set, so alternate-branch counts and the current leaf remain wrong until another lifecycle event occurs.

### 5. A late tree load can cross session boundaries

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/branch-tree-store.svelte.ts:164-171`
- **Status:** resolved
- **Fix:** Guard both snapshot and error publication with an open-generation or current-session check.

`open` awaits one session's load and then publishes its snapshot without checking the current session. If the user opens session B while session A's request is pending, A's tree and leaf can overwrite B's state. A's late failure can also replace B's error. Later selection or resume can send A's entry ID to B. Step 4 requires session-isolated state.

### 6. The find bar scrolls out of view when it finds a match

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/MessageList.svelte:449-451`; `client/src/lib/components/ConversationFindBar.svelte:45-56`
- **Status:** resolved
- **Fix:** Render the bar in the wrapper with sticky or absolute positioning above the scroll content.

The bar is rendered at the end of the scroll content and has no positioning rule. Opening find focuses the control, then selecting a match scrolls the transcript to that match. The bar leaves the viewport, so its Next and Previous controls become unreachable while the search remains open.

### 7. Escape in the compaction modal also closes the explorer

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/BranchExplorer.svelte:65-82`
- **Status:** resolved
- **Fix:** Return from the window handler when `event.defaultPrevented` is true.

The modal handles Escape and prevents the default event, but the window handler still runs and sees no open modal. It then closes the entire explorer. A user who dismisses the compaction modal loses the branch selection and search state instead of returning to the explorer.

### 8. Sticky preview actions can target a different message

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/MessageList.svelte:393-406`; `client/src/lib/components/StickyUserPreview.svelte:18-20,36-37`
- **Status:** resolved
- **Fix:** Key the sticky preview by `stickyEntryId`, or capture the entry ID when its menu opens.

The preview component remains mounted while its `message` prop changes. Its open menu and compaction modal then use the live `entryId`, not necessarily the message that opened the menu. Streaming or scrolling can therefore redo the wrong user message.

### 9. Sticky targeting misses layout and content changes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/MessageList.svelte:208-212`
- **Status:** resolved
- **Fix:** Recompute sticky positions from a content or layout observer, not only from entry-count changes, scroll, and window resize.

Step 7 requires target updates on scroll and layout changes. The effect tracks only `displayEntries.length`, so streamed content growth, panel resize, and other height changes do not refresh the target. The preview can remain attached to a message that is already visible or fail to switch to the next older message.

### 10. Branch counts re-project the whole tree for every message row

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/MessageList.svelte:116-120`; `client/src/lib/branch-tree.ts:190-194`; `client/src/lib/stores/branch-tree-store.svelte.ts:228-230`
- **Status:** resolved
- **Fix:** Derive one branch-count map per snapshot and expose segments for a set of search targets in one pass.

Each transcript row calls `abandonedBranchCountAt`, which rebuilds the complete tree projection. Full search also calls `segmentsToExpose` once per match. Long transcripts pay repeated tree traversals and projections during render and search, undermining the large-session behavior promised by the feature.

### 11. Tool-only assistant rows render blank in the explorer

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/branch-tree.ts:87`; `server/src/ws-handler.ts:187-192`
- **Status:** resolved
- **Fix:** Fall back from an empty `conversationText` to the existing preview or a visible placeholder.

The server emits an empty conversation text for assistant entries with tool calls but no assistant-authored text. The projection uses nullish fallback, so the empty string wins and the explorer renders a blank message row. Users cannot identify or select that branch point reliably.

### 12. Unrelated session-scoping work is bundled in the feature diff

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/DownloadToast.svelte:4-14`; `client/src/lib/components/ExtensionStatus.svelte:17-39,45-50,86-89,116-120,135-146`; `client/src/lib/stores/download-ui.svelte.ts:8-10,21-25,32-64`
- **Status:** dismissed
- **Fix:** Move commit `70e3dee` out of this feature range or record it as an intentional concurrent change.

This diff includes six files and three tests for session-scoped extension notifications and download toasts. They are outside the plan's impacted modules and test exceptions. The changes can be valid, but bundling them obscures review scope and complicates backports.

### 13. Explorer and action-menu behavior drifts from the approved mocks

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/BranchExplorer.svelte:263,336-338`; `client/src/lib/components/MessageActionMenu.svelte:57-60`
- **Status:** resolved
- **Fix:** Hide custom compaction until a message is selected and close the face menu before opening its compaction modal.

The tree mock hides the custom-compaction action until resume is available, but the implementation always renders a disabled button. The action-menu mock closes the face menu before showing the modal, while the implementation leaves both surfaces mounted. These differences change the settled affordances in the approved interaction contract.

### 14. Codemap omits the new branch-navigation surface

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `codemap.md:94`
- **Status:** resolved
- **Fix:** Replace the fork-entry wording and document `BranchTreeStore`, `BranchExplorer`, transcript redo, and conversation-find responsibilities.

The Web Client map still describes tail-aligned fork entry IDs and does not list the new branch-tree and transcript-navigation modules. The repository instructions require the codemap to stay current after structural changes. Stale ownership guidance makes later changes harder to locate.

### 15. Mobile jump-up is covered by the abort button

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/MessageList.svelte:454-461,527-552`
- **Status:** resolved
- **Fix:** Offset `.jump-up` above the mobile abort button.

Both floating controls use the same bottom-right position and z-index. During streaming, the abort button renders over the jump-up control, so the user cannot jump to the previous user message.
