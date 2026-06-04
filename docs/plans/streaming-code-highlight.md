# Plan: Streaming code syntax highlighting

## Context

Give the `write` tool a real client-side visualization and make code highlight
_as it streams_ rather than only when it settles — both for the new `write`
view and for markdown fenced code (which today highlights only on fence close).
See `docs/brainstorms/streaming-code-highlight.md`.

## Architecture

### Impacted Modules

**Client** — all changes live here; server, protocol, and `event-buffer.ts`
are untouched (same containment as the `edit` feature, per DR-008).

- **`smd-renderer.ts`** — currently highlights fenced code only in
  `end_token`. Extend it to also re-highlight (throttled) on each `add_text`
  into a code element, with `end_token` becoming the forced final flush. This
  is safe because of a verified smd property: `default_add_text` is
  `data.nodes[data.index].appendChild(document.createTextNode(text))` — smd
  holds references to **elements only**, never to text nodes, and inside a
  fence it only ever appends text. So replacing the `<code>` element's children
  (what highlighting does) never corrupts smd's node stack; the next append
  adds a fresh text node onto the same stable `<code>`, and the next highlight
  pass re-reads full `textContent` and rebuilds. Use `hljs.highlight(text,
{language})` → `innerHTML` rather than `hljs.highlightElement` (the latter
  guards against re-highlighting an element via `data-highlighted` and would
  no-op on the second pass). Language comes from the fence info-string already
  applied via `set_attr(LANG)`. Copy-button wiring is unchanged.

- **`ToolCall.svelte`** — add a `write` branch parallel to the existing `edit`
  branch. While streaming, feed `content.text` (raw JSON arg deltas) to a write
  content streamer to extract the file body; on finalize, read
  `content.args.content`. Always render the body through the new
  `WriteFileBlock`, passing `mode = isMarkdown ? 'markdown' : 'code'` (where
  `isMarkdown` is the path extension resolving to `markdown`). `WriteFileBlock`
  owns the collapse + copy chrome and the auto-expand / auto-collapse behavior
  for both modes, so `ToolCall` does not choose between components. The generic
  Arguments/Result fallback stays for non-`write`/`edit` tools.

- **`editor-language.ts`** — add a pure `inferLanguageFromPath(path)` that maps
  a file path's extension to an `EditorLanguage` via the existing
  `EXTENSION_LANGUAGE_MAP`. (Distinct from `inferLanguageFromTitle`, which
  regex-scans free-text titles; here we own a clean path and just split the
  extension.)

### New Modules

- **`code-highlight.ts`** (client `src/lib/`) — the shared streaming-highlight
  engine, used by both `smd-renderer.ts` and `WriteFileBlock.svelte`. Owns the
  ~100ms time-budget throttle and the forced-flush semantics. Pure
  `highlightToHtml` plus a stateful throttled scheduler. Depends only on the
  existing `hljs` instance from `syntax-highlighter.ts`.

- **`write-content.ts`** (client `src/lib/`) — mirrors `edit-diff.ts`: a
  `@streamparser/json` reader that surfaces the `write` tool's `content` value
  character-by-character from the raw args stream, plus a finalized extractor.
  Same byte-identity contract between streaming and finalized output that
  DR-008/DR-009 established for edit.

- **`WriteFileBlock.svelte`** (client `src/lib/components/`) — renders a file
  body inside a collapsible, copyable chrome, in one of two modes: `code`
  (syntax-highlighted `<pre><code>` via `code-highlight.ts`) or `markdown`
  (rendered via `TextBlock`, which inherits the new incremental fenced-code
  highlighting for free). The new composition the brainstorm flagged: no
  existing component combines highlighting/render + collapse + copy. Copy always
  yields the raw source text verbatim in **both** modes, and the long-file
  collapse wrapper applies to **both** modes — these are the two preconditions
  the brainstorm attached to rendering `.md` writes, so they must hold on the
  markdown path too, not only the code path.

### Interfaces

**`code-highlight.ts`**

```ts
// Pure: highlight a complete code string to hljs HTML markup.
// language: an hljs language id (e.g. 'typescript'); when null/unknown,
// returns HTML-escaped plain text (no spans). Never throws — on hljs error,
// falls back to escaped plain text.
export function highlightToHtml(text: string, language: string | null): string;

// Stateful throttled scheduler. schedule() requests a re-highlight of `el`
// from the latest text; at most one highlight runs per `intervalMs` (trailing
// edge). flush() forces an immediate highlight of the latest pending request
// and cancels any pending timer. dispose() cancels timers; idempotent.
export interface IncrementalHighlighter {
  schedule(el: HTMLElement, text: string, language: string | null): void;
  flush(): void;
  dispose(): void;
}
export function createIncrementalHighlighter(opts?: { intervalMs?: number }): IncrementalHighlighter;
```

Behavioral contract:

- Calling `schedule` repeatedly within `intervalMs` results in a single
  highlight pass at the end of the window, using the most recent `text`.
- `flush` always renders the latest scheduled `(el, text, language)` synchronously
  and leaves the element's `innerHTML` equal to `highlightToHtml(text, language)`.
- After `flush` (or a settled schedule) with no further `schedule` calls, the
  element content is final and correct regardless of prior throttle timing.
- Default `intervalMs` is ~100.

**`write-content.ts`**

```ts
export interface WriteArgs {
  path: string;
  content: string;
}

// Finalized extractor — returns args.content (or '' when absent/malformed).
export function extractWriteContent(args: unknown): string;

export interface WriteContentStreamer {
  write(jsonDelta: string): void; // push next raw JSON chunk
  readonly content: string; // live, growing file body
  dispose(): void; // idempotent
}
// Backed by @streamparser/json with path '$.content',
// { emitPartialValues: true, emitPartialTokens: true, keepStack: false }.
// Parser errors are swallowed (content stops advancing), matching edit-diff.
export function createWriteContentStreamer(): WriteContentStreamer;
```

Byte-identity contract: after a full args JSON is fed in chunks, the streamer's
`content` equals `extractWriteContent(finalArgs)` exactly (the streaming→finalized
handoff is invisible). This mirrors `edit-diff.test.ts`.

**`editor-language.ts`**

```ts
// Pure: extension → EditorLanguage via EXTENSION_LANGUAGE_MAP, or null when the
// path has no extension or an unmapped one.
export function inferLanguageFromPath(path: string): EditorLanguage | null;
```

**`WriteFileBlock.svelte`** (props)

```ts
{
  content: string;            // file body (streaming or finalized)
  mode: 'code' | 'markdown';  // render strategy
  language: string | null;    // hljs language id (used in 'code' mode)
  streaming?: boolean;        // drives throttled highlight + auto-scroll
}
```

Owns the collapse + copy chrome and the auto-expand-while-streaming /
auto-collapse-on-completion behavior for both modes. In `code` mode it renders a
`<pre><code>` highlighted via `code-highlight.ts` (throttled while `streaming`,
flushed when it ends). In `markdown` mode it renders `<TextBlock text={content}
streaming={...} />`. In both modes the copy button copies `content` verbatim
(raw source, never rendered text), and the show-more/collapse wrapper bounds
long files.

**`ToolCall.svelte`** (write branch)

- `isWrite = toolName === 'write'`.
- Streaming body: `createWriteContentStreamer()` fed from `content.text` deltas
  (same write-on-growth pattern as the edit streamer); finalized body:
  `extractWriteContent(content.args)`.
- `language = inferLanguageFromPath(path)`; `isMarkdown = language === 'markdown'`.
- Always `<WriteFileBlock content={body} mode={isMarkdown ? 'markdown' : 'code'} {language} streaming={...} />`.

## Tests

**Pre-test-write commit:** `2f6f048c003a568a70f508fac1728180e67d081c`

### Interface Files

- `client/src/lib/code-highlight.ts` — shared streaming-highlight engine: pure `highlightToHtml(text, language)` and the stateful `IncrementalHighlighter` (`schedule`/`flush`/`dispose`) created via `createIncrementalHighlighter({ intervalMs? })`. Stubs throw `not implemented`.
- `client/src/lib/write-content.ts` — `WriteArgs` shape, finalized `extractWriteContent(args)`, and the `WriteContentStreamer` (`write`/`content`/`dispose`) created via `createWriteContentStreamer()` (mirrors `edit-diff.ts`). Stubs throw `not implemented`.
- `client/src/lib/editor-language.ts` — added pure `inferLanguageFromPath(path)` mapping a file extension to an `EditorLanguage` via the existing `EXTENSION_LANGUAGE_MAP`. Stub throws `not implemented`.
- `client/src/lib/components/WriteFileBlock.svelte` — new component interface stub declaring the props contract (`content`, `mode: 'code' | 'markdown'`, `language`, `streaming?`). Renders a placeholder; real collapse/copy/render chrome lands in implementation.

### Test Files

- `client/src/lib/code-highlight.test.ts` — `highlightToHtml` markup/escaping contract and the `IncrementalHighlighter` throttle/flush/dispose contract (jsdom + fake timers).
- `client/src/lib/write-content.test.ts` — `extractWriteContent` finalized extraction and the `createWriteContentStreamer` byte-identity / progressive-growth contract.
- `client/src/lib/editor-language.test.ts` — extended with `inferLanguageFromPath` extension-mapping cases.
- `client/src/lib/smd-renderer.test.ts` — extended with a mid-stream fenced-code highlight case (fake timers): fenced code carries hljs span markup before the closing fence arrives, not only at `end_token`.

### Behaviors Covered

#### code-highlight (`highlightToHtml`)

- Emits hljs `<span class="hljs-*">` markup for a registered language and preserves the underlying source text.
- Returns HTML-escaped plain text with no spans when the language is null or unregistered.
- Never throws on an unknown language; empty input with a null language yields an empty string.

#### code-highlight (`IncrementalHighlighter`)

- `flush()` synchronously sets the element's `innerHTML` to `highlightToHtml(text, language)` for the latest scheduled values, using the most recent text when scheduled repeatedly.
- Null-language schedules flush to escaped plain text (no spans).
- Repeated `schedule` calls within `intervalMs` collapse to a single trailing-edge pass that renders the latest text; a settled schedule renders after the interval without an explicit flush.
- `dispose()` cancels a pending highlight and is idempotent; `flush()` with nothing scheduled does not throw.

#### write-content (`extractWriteContent`)

- Returns `args.content` for valid args (including empty string) and `''` for missing/non-string content, null/undefined, and non-object inputs.

#### write-content (`createWriteContentStreamer`)

- Starts empty; stays empty until a `content` value is seen.
- Final `content` equals `extractWriteContent(finalArgs)` whether fed in one chunk or one character at a time (byte-identity), preserving escaped characters verbatim.
- Reveals content progressively and grows only monotonically; swallows malformed JSON without throwing; `dispose()` is idempotent and does not mutate `content`.

#### editor-language (`inferLanguageFromPath`)

- Maps known extensions to their `EditorLanguage` (`.ts` → typescript, `.md` → markdown, `.svelte` → html), case-insensitively.
- Returns null for paths with no extension or an unmapped extension.

#### smd-renderer (mid-stream fenced-code highlight)

- A fenced code block opened with a language hint and streamed without a
  closing fence carries hljs span markup once the throttle window elapses —
  i.e. it highlights WHILE streaming, not only at `end_token`. Closing the
  fence afterward does not throw or lose content.

**Review status:** approved
