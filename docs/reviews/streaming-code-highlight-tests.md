# Test Review: Streaming code syntax highlighting

**Plan:** `docs/plans/streaming-code-highlight.md`
**Brainstorm:** `docs/brainstorms/streaming-code-highlight.md`
**Date:** 2026-06-03

## Summary

The tests cover the brainstorm intent well and sit at the right abstraction
level — the feature's testable logic is extracted into three pure modules
(`code-highlight.ts`, `write-content.ts`, `editor-language.ts`), and each is
exercised at its component boundary with happy paths, boundary conditions, and
error cases. Coverage mirrors the established `edit-diff` precedent (logic
tested, Svelte component chrome left to manual testing). One real gap was found
and closed: the headline markdown-surface behavior — fenced code highlighting
_while it streams_, not only on fence close — had no test, so a mid-stream
highlight case was added to `smd-renderer.test.ts`. The `WriteFileBlock` /
`ToolCall` chrome guarantees remain intentionally untested, deferred to the
manual-test phase per the edit precedent.

## Findings

### 1. Mid-stream fenced-code highlighting had no test

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/smd-renderer.test.ts:178-202`
- **Status:** resolved

Brainstorm Direction #2 and the plan's `smd-renderer.ts` change call for fenced
code to highlight _on each append (throttled)_ rather than only at `end_token`
— this is the headline behavior of the feature for the markdown surface. The
existing `smd-renderer.test.ts` only asserted highlight-on-close
(`applies syntax highlighting on streamed code blocks when they close`). The
throttle/flush _logic_ is fully covered in `code-highlight.test.ts`, but no test
pinned the observable renderer behavior: that an open (unclosed) fence carries
hljs span markup once the throttle window elapses.

Resolved (user-approved option 1B): added a fake-timer test that opens a
`typescript` fence, streams code without closing it, advances past the ~100ms
window, and asserts the `<code>` element's `innerHTML` contains `hljs-` span
markup before `end_token`, then confirms closing the fence afterward neither
throws nor loses content. The test is currently red (mid-stream highlight not
yet implemented), as expected pre-implementation; the other 22 smd-renderer
tests stay green. `smd-renderer.test.ts` was added to the plan's Tests section
as a file this feature touches, with the behavior documented.

### 2. WriteFileBlock chrome guarantees untested

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `client/src/lib/components/WriteFileBlock.svelte` (no test file)
- **Status:** dismissed

The brainstorm attaches two hard preconditions to rendering `.md` writes — the
copy button yields **raw source** (both modes) and a collapse wrapper bounds
long files (both modes) — plus mode routing (`.md`/`.markdown` → markdown, else
code) and auto-expand-while-streaming / auto-collapse-on-completion. None of
these have an automated test.

Dismissed (user-approved option 2A): this follows the established `edit`
precedent. `EditDiffBlock.svelte` and `ToolCall.svelte` carry zero tests; only
the pure logic module (`edit-diff.ts`) is tested. Component chrome stays
untested by design, and the two `.md` preconditions plus mode routing will be
verified in the manual-test phase rather than via component tests.

## No Issues

Beyond the two findings above, validation was clean across the tested modules:

- **Abstraction level.** All three tested modules are pure/logic surfaces
  exercised at their public boundary — inputs in, observable output out. The
  `IncrementalHighlighter` tests read `el.innerHTML` (the observable result),
  not internal scheduler state. No test reaches into internals or depends on
  implementation details.
- **Interface-only testing.** Every test imports only from the materialized
  interface stubs (`code-highlight.ts`, `write-content.ts`, `editor-language.ts`).
- **Path coverage.** `highlightToHtml` covers registered/null/unregistered
  languages, never-throws, and the empty-input case. `IncrementalHighlighter`
  covers flush-latest, trailing-edge throttle collapse, settled-schedule,
  dispose-cancels, dispose-idempotent, and flush-with-nothing. `write-content`
  covers all `extractWriteContent` branches plus the streamer's empty-start,
  byte-identity (one-chunk and char-by-char), verbatim escapes, progressive
  reveal, monotonic growth, malformed-JSON swallow, and idempotent dispose.
  `inferLanguageFromPath` covers known extensions, case-insensitivity, no
  extension, and unmapped extension.
- **No non-deterministic tests.** Throttle behavior is driven by Vitest fake
  timers; streamer partial-emission is deterministic for fixed char-by-char
  input. No timing, randomness, network, or filesystem dependencies.
- **Reasonable expectations.** Assertions couple to the documented interface
  contracts (e.g. `flush` leaves `innerHTML === highlightToHtml(text, language)`),
  satisfiable by any correct implementation; no over-specified internal-state
  or call-count assertions.
