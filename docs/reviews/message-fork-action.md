# Review: Message-level Fork Action

**Plan:** `docs/plans/message-fork-action.md`
**Diff range:** `1468103a5f0eea151fc1c54c971afaf4da5726a1..8eae9eb8a1df5658281820cb035941f2a2f6b894`
**Date:** 2026-04-12

## Summary

The plan was implemented faithfully across all five steps. Protocol additions, server fork handler, message-mapper entryId pass-through, client-side draft policy, Message fork action, MessageList orchestration, and the draft conflict dialog all match the plan's intent and architecture. One correctness concern: the draft conflict dialog can be dismissed externally (Escape / overlay click) without resolving the pending promise, leaving `handleFork` suspended.

## Findings

### 1. Draft conflict dialog promise leak on external dismiss

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/MessageList.svelte:18-31,238-251`
- **Status:** open

`promptDraftChoice()` creates a Promise resolved only through the four `resolveDraft()` button handlers. However, the bits-ui `Dialog.Root` defaults allow Escape and overlay-click dismissal, which sets `draftDialogOpen` to `false` via `bind:open` without calling `draftDialogResolve`. This leaves `handleFork` suspended forever — the promise never resolves. The closure held by `draftDialogResolve` is leaked until the next fork overwrites it.

Fix options: (a) add an `onOpenChange` callback that calls `resolveDraft('ignore')` when the dialog closes externally, or (b) pass `closeOnEscape={false}` and `closeOnOutsideClick={false}` to prevent external dismissal entirely. Option (a) is more user-friendly.

## No Issues

Plan adherence: no significant deviations found. All five steps implemented correctly, matching intent and architecture. Test immutability confirmed — no test files changed between pre-implementation commit and HEAD. Two unplanned changes in the diff range (`cwd` on `SessionInfo`, `tree` built-in command) predate the implementation phase and are not plan deviations.
