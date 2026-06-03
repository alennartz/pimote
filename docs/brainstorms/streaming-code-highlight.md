# Streaming code syntax highlighting

## The idea

Today only the `edit` tool gets bespoke client-side visualization (a live,
per-line colored diff streamed via `@streamparser/json` →
`EditDiffBlock.svelte`). The `write` tool gets nothing: it falls through the
generic path in `ToolCall.svelte` and dumps raw JSON arg deltas (escaped
newlines, no highlighting) while streaming, then `JSON.stringify(args)` on
completion.

The deeper gap: there is **no incremental/streaming syntax highlighter for
code** anywhere in the client. Markdown fenced code (`smd-renderer.ts`) _does_
highlight, but only on `end_token` — i.e. once the fence closes. While code
streams it's plain text; hljs runs once at the end.

Goal: build a streaming code highlighter and apply it to both surfaces — a
proper `write` tool view, and live highlighting of markdown fenced code as it
streams.

## Key decisions

### Scope: both surfaces, primitive may diverge per call site

Upgrade both the `write` view and markdown fenced code. The highlighting
_logic_ is shared (a tiny throttled re-highlight helper), but the two call
sites are allowed to differ — markdown lives inside smd's DOM pipeline (text
appended into a `<code>` node), `write` is a standalone Svelte component, and
forcing one component to serve both was rejected as unnecessary.

### Mechanism: throttled whole-buffer hljs re-highlight (not CodeMirror)

On each delta, re-run `hljs.highlight(buffer, { language })` and replace the
code element's contents. Rejected alternatives:

- **CodeMirror read-only / Lezer per block** — it's the "correct" incremental
  engine (truly incremental, viewport-only, no flicker, scales), but mounting
  an `EditorView` per fenced snippet inside smd's output is architecturally
  invasive and heavy for a chat transcript full of small snippets. Wrong fit.
- **Line-by-line freeze of completed lines** — cheap, but hljs is stateless
  per call and has no resumable tokenizer state, so highlighting lines in
  isolation breaks multi-line constructs (block comments, multi-line strings,
  template literals, JSX). Rejected.

### Flicker is a non-issue (the key insight)

Initial worry was tail-flicker: an unterminated string/comment coloring a huge
region that then snaps back. This **can't happen** because streaming is
append-only, left-to-right. An "unterminated" region is always the _tail_, and
the rest of the file hasn't streamed in yet. A string that opens at the tail
was correctly a string the whole time and stays one as text extends into it —
the already-rendered prefix keeps its color. The only retroactive recolors are
tiny char-scale lookahead cases (`/` → `//`, regex-vs-divide, `${` in a
template literal), not big regions. So whole-buffer re-highlight looks clean.

### Cost control: time-budgeted throttle (~100ms) + forced final pass

Whole-buffer re-highlight is O(n) per pass → O(n²) over a big write (no
resumable state means we can't cheaply highlight only the new tail). Bound it
by re-highlighting **at most ~every 100ms** (trailing) during the stream,
rather than per-frame or per-delta. A **guaranteed final highlight pass runs on
completion** so the settled state is always correct regardless of throttle
timing. Huge files simply update color less often mid-stream; they still end
correct. (Chosen over "always per-frame" and over "cap by size → fall back to
highlight-on-settle".)

### Language hints, not autodetect

Both surfaces have a real language hint, so we skip `hljs.highlightAuto`
(cheaper + more accurate): `write` infers language from the **file path
extension**; markdown uses the **fence info-string** (already applied by smd).
Unknown/extensionless `write` paths render as plain monospace, no highlight.

### `write` view = new composition of {highlight, collapse, copy}

The `write` view mirrors the `edit` treatment: stream the file `content` as a
highlighted code block, auto-expand while streaming, auto-collapse on
completion. It must combine **syntax highlighting + show-more/collapse + a copy
button**. No existing component provides all three — `EditDiffBlock` has none,
`StreamingCollapsible` has collapse only, smd code blocks have copy+highlight
but no collapse — so this is a small new composition, not a drop-in reuse.

### `.md`/`.markdown` writes render through smd, not the code path

When the `write` path extension is `.md`/`.markdown`, route the extracted
`content` stream through the existing smd markdown pipeline (`TextBlock.svelte`)
instead of the highlighted-code block — rendered output, not source. Rationale:
it's the same append-only streaming pipeline, rendered markdown is this app's
core aesthetic, and any fenced code blocks _inside_ the doc get our new
incremental fenced-code highlighting for free.

Tradeoff accepted: rendering hides literal bytes (whitespace, frontmatter, raw
HTML, the `#`/`*` characters). Judged acceptable because watching a write
stream is about glanceability, not byte auditing. Two refinements preserve the
useful bits: the **copy button copies raw source** (not rendered text), and the
rendered doc stays inside a wrapper so long files don't blow out the transcript.
Rejected alternatives: treating `.md` as hljs `markdown`-language _source_
(colorized but unrendered — consistency win, but loses the rendered aesthetic),
and a source⇄rendered toggle (more work, not worth it for v1).

### Extract `content` from JSON deltas, like edit-diff

Render the file text — not escaped JSON — from the first delta, by running a
`@streamparser/json` reader on `$.content` exactly as `edit-diff.ts` reads
`$.edits.*.oldText/newText`. This is the established pattern for turning raw arg
deltas into renderable structured values mid-stream.

## Direction

1. Shared helper: "re-highlight this code element/buffer with an optional
   language, throttled ~100ms trailing, with a forced flush." Built on the
   existing `hljs` instance in `syntax-highlighter.ts`.
2. `smd-renderer.ts`: highlight fenced code on each append (throttled) instead
   of only at `end_token`; keep the final pass and the existing copy button.
   Language from the fence info-string.
3. `write` tool view in `ToolCall.svelte`: a new bespoke block (parallel to the
   `edit` path) that streams `content` via a `@streamparser/json` reader on
   `$.content`. For `.md`/`.markdown` paths it renders through smd
   (`TextBlock.svelte`); for all other paths it highlights by path-extension
   language. Auto-expands while streaming / auto-collapses on done, and offers
   collapse + copy (copy always yields raw source).

## Open questions

- Whether the ~100ms time-budget cap is ever insufficient for truly enormous
  writes (causing visible stutter). Punt until a real file demonstrates it;
  the fallback would be a size cap → highlight-on-settle.
- Exact path-extension → hljs-language mapping coverage (reuse / extend
  whatever `editor-language.ts` and the registered language set already
  provide rather than inventing a new table).
