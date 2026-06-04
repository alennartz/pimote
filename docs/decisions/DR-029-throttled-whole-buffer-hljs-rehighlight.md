# DR-029: Throttled whole-buffer hljs re-highlight for streaming code

## Status

Accepted

## Context

The pimote client had no incremental syntax highlighter for code. Markdown
fenced code (`smd-renderer.ts`) highlighted only on `end_token` — i.e. once the
fence closed — and the `write` tool got no bespoke visualization at all (raw
JSON arg deltas while streaming, `JSON.stringify(args)` on completion). The goal
was to highlight code _as it streams_ on both surfaces: the new `write` tool
view and markdown fenced code.

`highlight.js` (the existing `hljs` instance in `syntax-highlighter.ts`) is
stateless per call — it has no resumable tokenizer state between invocations, so
there is no cheap way to highlight only the newly-arrived tail and append it.

## Decision

On each streamed delta, re-run `hljs.highlight(wholeBuffer, { language })` over
the entire accumulated code buffer and replace the code element's contents,
throttled to **at most one pass per ~100ms** (trailing edge) during the stream,
with a **forced final flush** on completion. The shared engine lives in
`code-highlight.ts` (`highlightToHtml` + a stateful `IncrementalHighlighter`)
and is used by both `smd-renderer.ts` (fenced code) and `WriteFileBlock.svelte`
(the write view).

Language comes from a real hint on both surfaces (the markdown fence
info-string; the `write` path extension), so `hljs.highlightAuto` is skipped —
cheaper and more accurate.

**Rejected alternatives:**

- **CodeMirror read-only / Lezer per block.** This is the "correct" incremental
  engine — truly incremental, viewport-only, no flicker, scales to large files.
  Rejected because mounting an `EditorView` per fenced snippet inside smd's
  streaming output is architecturally invasive and heavy for a chat transcript
  full of small snippets. Wrong fit for the surface.
- **Line-by-line freeze of completed lines.** Highlight each line once it
  completes and never touch it again — cheap, bounded cost. Rejected because
  hljs is stateless per call with no resumable tokenizer state, so highlighting
  lines in isolation breaks multi-line constructs (block comments, multi-line
  strings, template literals, JSX).

The key insight that makes naive whole-buffer re-highlight look clean despite
re-coloring everything each pass: **streaming is append-only, left-to-right, so
tail-flicker cannot happen.** An "unterminated" region (open string/comment) is
always the _tail_ — the rest of the file hasn't streamed in yet. A string that
opens at the tail was correctly a string the whole time and stays one as text
extends into it; the already-rendered prefix keeps its color. The only
retroactive recolors are tiny char-scale lookahead cases (`/` → `//`,
regex-vs-divide, `${` in a template literal), never large regions.

## Consequences

- Whole-buffer re-highlight is O(n) per pass → O(n²) over a large write (no
  resumable state means we can't cheaply highlight only the new tail). The
  ~100ms throttle bounds this: huge files simply update color less often
  mid-stream. A guaranteed final pass runs on completion, so the settled state
  is always correct regardless of throttle timing.
- If a truly enormous write ever causes visible mid-stream stutter despite the
  throttle, the fallback is a size cap → highlight-on-settle for that file. Not
  implemented; punted until a real file demonstrates the need.
- The throttle/flush logic is unit-tested at the engine boundary
  (`code-highlight.test.ts`, fake timers) and the renderer behavior is pinned by
  a mid-stream `smd-renderer.test.ts` case (open fence carries `hljs-` markup
  before `end_token`).
- `highlightToHtml` returns markup only (no auto-added `hljs` class, unlike
  `hljs.highlightElement`), so every call site adds the `hljs` class itself.
  `highlightElement` is deliberately not used anywhere — it guards
  re-highlighting via `data-highlighted` and would no-op on the second pass.
- The same engine serves both surfaces, but the two call sites are allowed to
  differ (smd's DOM pipeline vs. a standalone Svelte component); forcing one
  component to serve both was rejected as unnecessary.
