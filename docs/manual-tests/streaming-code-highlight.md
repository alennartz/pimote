# Manual Testing — streaming-code-highlight

## Smoke Suite

This run smokes the journeys that share state with the new `write`-tool
visualization and the markdown rendering path:

- **Journey 1 (Connect and open a session)** — the driver boots `bin/pimote.js`
  in a sandbox, the PWA connects, `list_folders` populates, a fabricated
  session opens. Entry point for everything below.
- **Journey 2 (Prompt → streamed assistant response)** — the surface this
  topic changes. The new `write` view replaces the generic args dump in the
  tool-call render path; assistant markdown messages get mid-stream fenced-code
  highlighting. Exercised here via fabricated finalized sessions (the
  finalized/settled half of the journey).

Other journeys (3–9: extension UI, takeover, slash/tree, panels, push, voice,
Android) are untouched by this client-only, render-path change and are not
re-smoked this run.

## Topic-Specific Tests

Derived from the plan, brainstorm, the test-review's two deferred preconditions,
and the focus hints. Each notes whether it is observable from a **finalized**
(disk-fabricated) session or requires a **live token stream**.

1. **Mode routing by file extension** — a `.ts`/code write renders a
   syntax-highlighted `<pre><code class="hljs">`; a `.md`/`.markdown` write
   renders as live markdown via `TextBlock` (rendered output, not raw source).
   _(finalized)_
2. **Precondition (a): copy yields RAW source verbatim — BOTH modes.** The
   copy button copies `content` exactly (escaped chars, frontmatter, `#`/`*`
   bytes intact), never the rendered/highlighted text, in code AND markdown
   mode. _(finalized)_
3. **Precondition (b): show-more/collapse wrapper bounds long files — BOTH
   modes.** A >20-line write shows the "Show more… (N lines)" toggle and the
   collapsed body is height-clamped, in code AND markdown mode. _(finalized)_
4. **Code-mode highlighting is real hljs markup** — the code body carries
   `hljs-*` span classes for a registered language and the underlying source
   text is preserved. _(finalized)_
5. **Markdown-mode renders markdown, incl. fenced code highlighted** — a `.md`
   write with a fenced ```code block renders headings/lists as HTML and the
   inner fence carries hljs markup. _(finalized — exercises the same smd path
   that highlights mid-stream)_
6. **Auto-expand while a write streams / auto-collapse on completion.**
   _(live stream)_
7. **Mid-stream code highlighting in the write view** — code inside the
   streaming `<pre><code>` picks up hljs spans before the stream settles.
   _(live stream)_
8. **Mid-stream fenced-code highlighting in assistant markdown** — code inside
   a ```fence in a streaming assistant message highlights WHILE streaming, not
   only at fence close. _(live stream — but directly unit-tested; see Results)_

## Tools

- Reused: `agent-browser` (cross-repo skill) for PWA drive; the pimote-boot /
  sandbox / pi-session-fabrication pattern from `cost-accumulation-smoke`.
- New: `tools/manual-test/streaming-code-highlight-smoke/` — fabricates pi
  sessions containing completed `write` tool calls (code + markdown, short +
  long), boots pimote, and drives the PWA via `agent-browser` to assert the
  finalized rendering contracts (mode routing, copy-raw both modes, collapse
  both modes, code highlighting, markdown rendering).
- Improved: none.

## Harness Limitations

The driver fabricates pi sessions **on disk** and opens them, so it observes
the **finalized / settled** render state only. It structurally cannot surface
behaviors that exist only during a live token stream:

- **Auto-expand-while-streaming / auto-collapse-on-completion** (topic test 6)
  — needs `streaming=true` flowing through `ToolCall`/`WriteFileBlock`.
- **Mid-stream code highlighting in the write view** (topic test 7) — needs
  partial `content.text` deltas.

These two are part of the topic's headline behavior and were explicitly
deferred to this manual-test phase by the test-review (finding #2, dismissed
2A). A disk-fabricated harness cannot see them; only a live stream (real LLM,
or a fake streaming provider emitting a `write` tool call) can. This gap is
escalated to the parent.

Mitigations that DO cover the streaming logic without a live stream:

- `code-highlight.test.ts` — `IncrementalHighlighter` throttle/flush/dispose
  (the engine behind both mid-stream surfaces), fake-timer driven.
- `write-content.test.ts` — `createWriteContentStreamer` byte-identity +
  progressive growth (the JSON-delta → file-body path the write view streams).
- `smd-renderer.test.ts` — a fake-timer test asserting an OPEN fence carries
  `hljs-` markup before `end_token` (topic test 8's observable behavior, at the
  renderer boundary).

## Results

Driver: `tools/manual-test/streaming-code-highlight-smoke/streaming-code-highlight-smoke.mjs`
(boots `bin/pimote.js` in a sandbox, fabricates one session with 4 completed
`write` tool calls, drives the PWA via `agent-browser`). 407 client unit tests
also green (`npm test`).

### Smoke Suite

- **Journey 1 (Connect + open session)** — **pass.** PWA connected, folder
  picker populated, fabricated session opened, all 4 write tool blocks rendered.
- **Journey 2 (Prompt → streamed response, settled half)** — **pass.** The
  write tool-call render path produces `WriteFileBlock` chrome instead of the
  generic args dump; markdown writes render through the smd pipeline. Coherence:
  **looks coherent** — screenshot shows colorized TS keywords + a top-right Copy
  button in code mode, and a rendered `<h1>`/bold/list with highlighted inner
  fence in markdown mode (not raw source). Matches brainstorm intent.

### Topic-Specific Tests

1. **Mode routing by extension** — **pass.** `.ts` → `data-mode=code`
   (`pre.wfb-code code`); `.md` → `data-mode=markdown` (`.wfb-markdown`).
2. **Precondition (a): copy = RAW source, both modes** — **pass.** Code-mode
   copy byte-identical to the `.ts` source; markdown-mode copy byte-identical to
   the `.md` source and retains literal `#` / ` ``` ` bytes (captured by
   overriding `clipboard.writeText` — headless clipboard reads are unreliable).
3. **Precondition (b): collapse bounds long files, both modes** — **pass.**
   Both the 33-line `.ts` and the 33-line `.md` writes show a
   "Show more… (33 lines)" toggle and clamp the body (`.wfb-body.clamped`) when
   collapsed.
4. **Code-mode real hljs markup** — **pass.** Code `<code>` carries the `hljs`
   class + 12 `hljs-*` spans and preserves the source text verbatim.
5. **Markdown-mode renders markdown incl. fenced code** — **pass.** Heading →
   `<h1>`, list → `<li>`s, no literal `# Streaming` text, inner ```ts fence
   highlighted (6 hljs spans).
6. **Auto-expand/auto-collapse while streaming** — **open (not exercised).**
   Live-stream-only; covered at the engine boundary by
   `code-highlight.test.ts` + the `ToolCall` edit-precedent. See Harness
   Limitations / Open Issues.
7. **Mid-stream code highlighting in the write view** — **open (not
   exercised).** Live-stream-only; engine covered by `code-highlight.test.ts`
   (`IncrementalHighlighter`) and the JSON-delta path by `write-content.test.ts`.
   See Harness Limitations / Open Issues.
8. **Mid-stream fenced-code highlighting in assistant markdown** — **pass
   (via unit test).** `smd-renderer.test.ts` asserts an OPEN fence carries
   `hljs-` markup before `end_token` at the renderer boundary — the observable
   behavior, not just the engine. The same smd path was exercised live in the
   finalized markdown write (test 5).

## Plan Updates

`tools/manual-test/PLAN.md` Journey 2 ("Prompt → streamed assistant response")
updated: its tool-call-visualization clause now names the `write` →
`WriteFileBlock` render path (highlighted code / rendered markdown) alongside
the existing `edit` diff, and records `streaming-code-highlight-smoke` as a
settled-state driver for that surface. No new primary journey added (this is a
render-path enrichment of journey 2, not a new user journey).

## Open Issues

- **Live-stream-only behaviors not integration-tested** (topic tests 6 & 7:
  auto-expand/auto-collapse during a write stream, and mid-stream code
  highlighting in the write view). The disk-fabricated harness structurally
  cannot drive a live token stream. Per parent decision (option A), accepted as
  a documented harness limitation for this smoke phase: the streaming _logic_ is
  unit-tested at the engine boundary (`code-highlight.test.ts` throttle/flush,
  `write-content.test.ts` byte-identity), matching the `edit` precedent where
  component chrome was never integration-tested. Revisit if a future topic makes
  a live-stream harness (fake streaming provider) worth building.
