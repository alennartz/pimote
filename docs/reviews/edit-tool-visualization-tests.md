# Test Review: Edit Tool Visualization

**Plan:** `docs/plans/edit-tool-visualization.md`
**Brainstorm:** `docs/brainstorms/edit-tool-visualization.md`
**Date:** 2026-04-17

## Summary

Tests in `client/src/lib/edit-diff.test.ts` comprehensively cover the pure-logic contract defined in the plan's Interfaces section — `buildEditDiffMarkdown` and `createEditDiffStreamer`. Coverage includes happy paths, empty/missing edges, multi-line and multi-edit cases, streaming chunk-size invariance, partial-value visibility, byte-identity between streaming and finalized output, and the malformed-JSON error path. Component-level concerns (auto-expand/collapse, streaming-vs-parsed source selection, result section preservation) in `ToolCall.svelte` are not tested, consistent with the repo's convention of testing pure logic in `lib/*.test.ts` only (no `.svelte` component tests exist in the codebase). Tests are at the correct abstraction boundary, deterministic, and assertions match the interface spec without over-constraining implementation.

## Findings

### 1. Test name slightly misleads on "partial" newline splitting

- **Category:** nit
- **Severity:** nit
- **Location:** `client/src/lib/edit-diff.test.ts:164-170`
- **Status:** dismissed

The test titled `splits a partial oldText containing newlines into multiple - lines` writes the full JSON in a single `write()` call and asserts on the final markdown, so it exercises final-state newline splitting rather than in-flight splitting of a still-growing partial value. The assertion itself is correct and valuable (newlines inside an `oldText` value produce separate `-` lines). The char-by-char tests above it already cover the streaming/partial side of the behavior. Dismissed as a naming nit — no functional gap, no fix.

## No Issues

All brainstorm intent that falls within the plan's test scope (the `edit-diff.ts` pure logic) is covered. Tests are at the correct component boundary (public functions / returned interface), deterministic, and match the spec byte-for-byte without over-specification. Component-level behaviors in `ToolCall.svelte` are intentionally outside the tested surface per project convention.
