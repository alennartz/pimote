# Review: Edit Tool Visualization

**Plan:** `docs/plans/edit-tool-visualization.md`
**Diff range:** `d088fd7ea1e18177769167ed078cc360096a172c..HEAD`
**Date:** 2026-04-17

## Summary

The plan was implemented faithfully. Both the pure `buildEditDiffMarkdown` and stateful `createEditDiffStreamer` match the architecture and all 20 behavioral tests pass. `ToolCall.svelte` wiring follows the spec: edit-specific streaming-vs-finalized source selection, auto-expand/collapse, and non-edit tool rendering untouched. Test files have not been modified since the pre-implementation commit. One minor unplanned parser option was added; no correctness issues of note.

## Findings

### 1. Unplanned `emitPartialTokens: true` option on the JSON parser

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/edit-diff.ts:117`
- **Status:** resolved

The plan's Step 2 specifies constructing `JSONParser` with exactly `{ emitPartialValues: true, paths: [...], keepStack: false }`. The implementation additionally passes `emitPartialTokens: true`. This is harmless — the `onValue` handler only processes string values under the filtered paths, and tests confirm the streaming behavior works — but it's an unplanned addition. If `emitPartialValues` alone is sufficient (as the plan assumes), drop `emitPartialTokens`; if it was required to get tests green, the plan's parser-options list is inaccurate and should be updated.

**Resolution:** Verified by removal — dropping `emitPartialTokens` fails the `reveals oldText - lines progressively as a partial string grows` test. The option is required for the streaming character-by-character reveal (without it, string values are only surfaced at structural tokens such as the closing `"`). Restored `emitPartialTokens: true` and updated the plan's Step 2 parser-options list to include it with a rationale.

### 2. Streaming cleanup briefly blanks the rendered diff before the finalized view appears

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/ToolCall.svelte:43-54, 75`
- **Status:** open

When `streaming` transitions to `false`, the cleanup branch calls `streamer.dispose()` and sets `streamingMarkdown = ''`. `editMarkdown` then falls back to `finalizedMarkdown`, which requires `content.args` to be populated. If the event that flips `streaming` off arrives in a tick before `content.args` is populated, `editMarkdown` is briefly `''`, the `{#if isEdit && editMarkdown}` branch is skipped, and the UI falls through to the raw `Arguments` `StreamingCollapsible`. Depending on how upstream events are ordered in practice this may be imperceptible, but it's a potential single-frame flicker at the handoff the plan explicitly wanted to avoid ("the rendered DOM doesn't visibly restructure at the handoff"). A safer pattern is to keep the last `streamingMarkdown` value around until `finalizedMarkdown` is non-empty, then clear.

## No Issues

- Plan adherence: no significant deviations beyond finding #1.
- Test immutability: `client/src/lib/edit-diff.test.ts` is unchanged between the pre-implementation commit (`28a6a08`) and HEAD.
- Non-edit tool rendering: unchanged — `argsText`, `resultText`, and header logic paths are untouched when `isEdit` is false.
- Correctness pass: no error-handling, race, resource-leak, or edge-case issues found beyond finding #2. `dispose()` is idempotent; parser errors are swallowed via both `try/catch` and `onError`; streamer lifetime is bounded to the streaming window.
