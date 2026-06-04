# Review: Streaming code syntax highlighting

**Plan:** `docs/plans/streaming-code-highlight.md`
**Diff range:** `0cd2976231aff1402cc8eb9411d6bebbd6c85797..c9e7f1de2beaf2ffa657a0e1c38e73e40b95af68`
**Date:** 2026-06-03

## Summary

The plan was implemented faithfully across all seven steps — the three pure
modules (`code-highlight.ts`, `write-content.ts`, `editor-language.ts`), the
`smd-renderer.ts` rework, and the `WriteFileBlock.svelte` / `ToolCall.svelte`
wiring all match the architecture and step intent. Test files are unmodified
since the pre-implementation commit (immutability holds), the 68 unit tests
pass, and both `svelte-check` (0 errors/0 warnings) and the contained-to-client
boundary from DR-008 are respected. No correctness defects were found; two minor
cosmetic/UX nits are noted below.

## Findings

### 1. Collapsed-height clamp is code-tuned but reused for markdown mode

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/WriteFileBlock.svelte:150-153` (`.wfb-body.clamped`)
- **Status:** open

The clamp `max-height: calc(20 * 1.5 * 0.875em + 24px)` is derived from the
code-mode line-height/font-size. It is applied to `.wfb-body` in both modes, so
in markdown mode the collapsed height is only an approximation of 20 source
lines (rendered markdown has variable line heights from headings, lists, code
fences). The "Show more… (N lines)" count also uses `content.split('\n').length`
(raw source lines), which won't exactly match rendered height. Purely cosmetic —
the collapse still functions and bounds long files; the clamp point is just
imprecise on the markdown path.

### 2. Manual collapse during streaming is overridden on each delta

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/WriteFileBlock.svelte:55` (`let expanded = $derived(streaming)`)
- **Status:** open

`expanded` is a writable `$derived(streaming)`. The toggle button reassigns it,
but while `streaming` is true every `content` delta re-runs the derived and
resets `expanded` back to `true`, so a user who clicks "Show less" mid-stream
will see it snap back open on the next chunk. This is consistent with the plan's
"expand while streaming is true" intent (and only settles to a stable, manually
toggleable state once streaming ends, as the inline comment notes), so it is
by-design rather than a bug — flagged only because the override is silent.

## No Issues

- **Plan adherence:** no significant deviations. Steps 1–7 are each reflected in
  the diff and match the architecture (whole-buffer re-highlight via a shared
  `IncrementalHighlighter`, `add_text` schedule + `end_token` flush in
  `smd-renderer.ts` with `attachCopyButton`/`default_end_token` preserved,
  `@streamparser/json` streamer mirroring `edit-diff.ts`, extension→language
  mapping, and a parallel `write` branch in `ToolCall.svelte` that takes
  priority over the generic args fallback).
- **Test immutability:** the four test files in the `## Tests` section show no
  changes between `pre-implementation-commit` (`0cd29762`) and HEAD.
- **Containment:** all changes live under `client/`; server, protocol, and
  `event-buffer.ts` are untouched (DR-008).
- **Correctness pass:** error paths are guarded (`highlightToHtml` never throws,
  parser errors swallowed, clipboard failure caught, smd `flush()` wrapped in
  try/catch), timers/parsers are disposed (`dispose()` on effect teardown and on
  streaming end), and the byte-identity streaming→finalized handoff matches the
  established edit precedent. No race, leak, or injection issues found
  (`highlightToHtml` HTML-escapes the null/unknown-language fallback).
