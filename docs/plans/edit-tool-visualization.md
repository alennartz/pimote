# Plan: Edit Tool Visualization

## Context

Change how `edit` tool calls render in the pimote client: replace the raw-JSON Arguments dump with a live-streaming diff view using markdown ` ```diff` code blocks, and adopt the ThinkingBlock auto-expand/collapse pattern so the diff is visible while it builds up. See `docs/brainstorms/edit-tool-visualization.md` for exploration.

## Architecture

### Impacted Modules

- **Client** — `ToolCall.svelte` gains edit-specific rendering. When the tool name is `edit`, the component feeds streaming JSON deltas through a streaming JSON parser, derives a diff-formatted markdown string from observed `oldText`/`newText` values, and renders it via `TextBlock`. The component also adopts the auto-expand-while-streaming, auto-collapse-on-completion behavior modeled on `ThinkingBlock.svelte`. No other client files are structurally affected; existing pieces (`TextBlock`, smd renderer, `syntax-highlighter.ts` with its `diff` language registration, `.hljs-addition`/`.hljs-deletion` styles in `highlight-theme.css`) are reused as-is.

No server, protocol, or other module is affected. The wire format is unchanged — edit tool calls continue to stream raw JSON deltas over `message_update` events as they do today; all transformation is client-side inside the rendering component.

### Interfaces

#### Diff markdown shape

Given parsed edit args of the form:

```ts
interface EditArgs {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}
```

…the rendered markdown is a sequence of separate fenced diff blocks, one per `edits[]` entry, separated by blank lines:

````markdown
​```diff

- <oldText line 1>
- <oldText line 2>

* <newText line 1>
* <newText line 2>
  ​```

​```diff

- <oldText of second edit>

* <newText of second edit>
  ​```
````

Rules:

- Each line of `oldText` becomes a `-` line; each line of `newText` becomes a `+` line. No line-level diff computation.
- Empty `oldText` or empty `newText` still produces at least one marker line for the non-empty side (an append-only edit shows `+` lines with no `-`; a pure deletion shows `-` lines with no `+`).
- Lines preserve their original text verbatim aside from the `- ` / `+ ` prefix. No escaping of markdown characters is needed — smd + highlight.js handle the `diff` language fence.
- The file path from `args.path` is **not** included in the markdown; it is already shown in the tool call header.

#### Edit diff builder (pure function)

A pure helper converts fully-parsed edit args to the diff markdown string. Used for the completed/restored message state and as a reference for the streaming output.

```ts
// Pure, synchronous. Used for finalized/restored edits.
function buildEditDiffMarkdown(args: EditArgs): string;
```

Behavior:

- Returns the empty string if `args.edits` is missing or empty.
- Emits one ` ```diff ` block per edit entry, in order.
- The output must be byte-identical to what the streaming builder produces once all deltas have been consumed, so the visible diff does not re-layout when the component transitions from streaming-text mode to parsed-args mode.

#### Streaming diff builder (stateful)

A stateful builder consumes raw JSON deltas (as they arrive in `content.text`) and produces a growing diff markdown string. Wraps `@streamparser/json`.

```ts
interface EditDiffStreamer {
  /** Push the next chunk of raw JSON text received from the wire. */
  write(jsonDelta: string): void;
  /** The current diff markdown string, reflecting every partial + complete oldText/newText seen so far. */
  readonly markdown: string;
  /** Release parser resources. Safe to call multiple times. */
  dispose(): void;
}

function createEditDiffStreamer(): EditDiffStreamer;
```

Behavior:

- Internally constructs a `JSONParser` configured with `emitPartialValues: true` and `paths: ['$.edits.*.oldText', '$.edits.*.newText']`.
- Each `onValue` callback updates `markdown` so it reflects the latest partial value for the relevant edit index and field.
- A new `oldText` value for edit index N opens a new ` ```diff ` block (closing the previous one first with a blank line separator).
- A new `newText` value for edit index N appends `+` lines below the `-` lines of that same block.
- As a partial string grows (character by character), the corresponding `-`/`+` lines update in place within `markdown`. Newlines inside the partial value split into additional `-`/`+` lines.
- Empty buffer before any `oldText`/`newText` has been seen → `markdown` is the empty string (the block renders nothing until content appears).
- `dispose()` detaches from the parser and is a no-op on subsequent calls. It does not mutate `markdown`.

Parser errors (malformed JSON mid-stream, which should not happen for well-formed model output) are swallowed — the `markdown` string simply stops advancing; the component will fall back to the finalized args view once `message_end` arrives.

#### ToolCall.svelte contract (edit-specific)

Existing props unchanged:

```ts
{
  content: PimoteMessageContent;   // tool_call or tool_result
  streaming?: boolean;             // args are still streaming in
  inProgress?: boolean;            // tool is executing
  partialResult?: string;          // (unused for edit in the new view, but may surface for errors)
  result?: unknown;
  isError?: boolean;
}
```

When `content.toolName === 'edit'`, the component:

1. **Chooses a diff source:**
   - While `streaming === true` and `content.text` is non-empty: feed `content.text` into an `EditDiffStreamer` and bind its `markdown` to a `TextBlock` (with `streaming={true}`).
   - Otherwise (streaming has ended, or we're rendering a finalized/restored message): derive the diff from `content.args` via `buildEditDiffMarkdown(args)` and render through `TextBlock` with `streaming={false}`.
   - Transition from streaming to parsed-args must produce identical markdown (see `buildEditDiffMarkdown` rule above) so the rendered DOM doesn't visibly restructure at the handoff.

2. **Auto-expand/collapse (ThinkingBlock pattern):**
   - Expanded state is local `$state`, initially `false`.
   - A `$effect` sets expanded to `true` when either `streaming` or `inProgress` is true, and back to `false` when both become false. Manual user toggles during streaming are preserved (same pattern ThinkingBlock uses — the `$effect` re-asserts on state changes but the user can override mid-stream).
   - The header remains clickable at all times.

3. **Header shape:** unchanged — the chevron, status icon, tool name, file path (already shortened), and status label all remain as today. No diff content bleeds into the header.

4. **Body when expanded:**
   - The diff markdown is rendered via `TextBlock` in place of the previous Arguments section.
   - The existing Result section is preserved: when `result` is defined or `partialResult` has content, it renders beneath the diff using the existing `StreamingCollapsible`. Error results surface here unchanged.

For non-edit tool calls (`toolName !== 'edit'`), the component's behavior is unchanged from today — same collapsed-by-default header, same Arguments / Result sections, same `StreamingCollapsible` rendering. No regressions for `read`, `write`, `bash`, etc.

### Technology Choices

**Incremental JSON parsing library: `@streamparser/json`**

- Event-driven SAX-style parser with `paths` filtering (`$.edits.*.oldText`, `$.edits.*.newText`) — we subscribe only to the string values we care about and ignore structural scaffolding.
- `emitPartialValues: true` delivers partial string tokens as they're still being parsed, which is exactly the character-by-character streaming we want.
- Zero dependencies, works in browsers (client uses it directly; no server-side change).
- Fully JSON-spec compliant, handles escape sequences and unicode correctly without hand-rolled logic.

**Alternatives considered:**

- **`partial-json`** (by promplate) — purpose-built for LLM partial output, simpler API. Rejected because it reparses the entire accumulated buffer on every delta and requires diffing successive parse results to detect incremental changes. `@streamparser/json` is push-based, does the diffing implicitly via its `onValue` callbacks, and filters by path so we don't wade through the whole object on each chunk.
- **Hand-rolled incremental JSON string extraction** (regex / manual state machine over the raw JSON text to pull out `oldText`/`newText` values as they complete). Rejected as fragile — escape handling (`\"`, `\\`, `\uXXXX`, newlines in string values) is easy to get wrong in ways that silently corrupt output. A purpose-built streaming parser gets these right for free.
- **Server-side transform** (generate diff markdown on the server and stream that over the wire instead of raw JSON). Rejected because the server receives the same token-by-token JSON stream from the pi SDK — the incremental parsing problem is identical there, just relocated. Keeping the transform client-side avoids changing the wire protocol and localizes the whole feature to one component.

## Tests

**Pre-test-write commit:** `d088fd7ea1e18177769167ed078cc360096a172c`

### Interface Files

- `client/src/lib/edit-diff.ts` — defines `EditArgs` type, `buildEditDiffMarkdown(args)` pure function (stub), and `createEditDiffStreamer()` factory returning an `EditDiffStreamer` (stub). No implementation yet — both stubs throw `"not implemented"`.
- `client/package.json` / `client/package-lock.json` — added `@streamparser/json` dependency (consumed by the forthcoming streamer implementation; not yet imported).

### Test Files

- `client/src/lib/edit-diff.test.ts` — behavioral tests for `buildEditDiffMarkdown` and `createEditDiffStreamer`.

### Behaviors Covered

#### `buildEditDiffMarkdown`

- Returns an empty string when `edits` is an empty array.
- Returns an empty string when `edits` is missing entirely.
- A single edit renders as a single ` ```diff ` fenced block.
- Multi-line `oldText` / `newText` produce one `-` / `+` line per source line.
- Line contents are preserved verbatim — no markdown escaping is performed.
- The file path from `args.path` is not emitted into the markdown.
- An append-only edit (empty `oldText`) emits only `+` lines.
- A pure deletion (empty `newText`) emits only `-` lines.
- Multiple edits are separated by a blank line between diff blocks.
- Edits appear in the order given in `args.edits[]`.

#### `createEditDiffStreamer`

- Fresh streamer starts with `markdown === ''`.
- Markdown stays empty while only structural JSON (no observed string values) has been fed.
- After writing the full JSON of some `args`, the streamer's `markdown` equals `buildEditDiffMarkdown(args)` exactly — the streaming and finalized renderings match byte-for-byte.
- The same final markdown is produced regardless of chunk boundaries, including character-by-character delivery.
- During streaming, partial `oldText` values are visible as in-progress `-` lines before the value completes.
- A partial value containing newlines is split into multiple `-` / `+` lines as the newlines arrive.
- Encountering a new edit index opens a new ` ```diff ` fenced block.
- `+` lines for an edit appear after the `-` lines of the same edit's block.
- `dispose()` is idempotent and does not mutate `markdown`.
- Malformed JSON mid-stream is swallowed — `write()` does not throw.

**Review status:** approved

## Steps

**Pre-implementation commit:** `28a6a08be147c145318a5fbd27826f17f1efacf6`

### Step 1: Implement `buildEditDiffMarkdown`

Fill in the stub in `client/src/lib/edit-diff.ts`. Make it a pure function that:

- Returns `''` when `args.edits` is missing/undefined or an empty array (`!args.edits || args.edits.length === 0`).
- For each entry in `args.edits`, produces a ` ```diff ` fenced block:
  - Split `oldText` on `\n` and emit one `- <line>` line per piece; if `oldText === ''`, emit no `-` lines.
  - Split `newText` on `\n` and emit one `+ <line>` line per piece; if `newText === ''`, emit no `+` lines.
  - No markdown escaping — the raw line text goes verbatim after `- ` / `+ `.
- Joins blocks with a single blank line between them. No trailing newline on the final block. No content is derived from `args.path`.

Reference shapes (exact outputs from `edit-diff.test.ts` — use these to validate):

- `{ edits: [{ oldText: 'hello', newText: 'world' }] }` → `` `\`\`\`diff\n- hello\n+ world\n\`\`\`` ``
- `{ edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] }` → two blocks joined by `\n\n`.
- `{ oldText: '', newText: 'added\nline' }` → `` `\`\`\`diff\n+ added\n+ line\n\`\`\`` ``.
- `{ oldText: 'gone', newText: '' }` → `` `\`\`\`diff\n- gone\n\`\`\`` ``.

**Verify:** `cd client && npx vitest run src/lib/edit-diff.test.ts` — all `buildEditDiffMarkdown` tests pass.
**Status:** done

### Step 2: Implement `createEditDiffStreamer`

Fill in the stub in `client/src/lib/edit-diff.ts`. Import `JSONParser` from `@streamparser/json` and build a stateful streamer that keeps a per-edit-index record of the latest partial `oldText` and `newText` strings, then re-renders the full markdown string from that record after every value event. Using the same renderer as Step 1 (extracted into a private helper that accepts `Array<{ oldText: string; newText: string }>` with defaults of `''`) guarantees byte-for-byte equality with `buildEditDiffMarkdown` once all values are final.

Construct the parser as:

```ts
new JSONParser({
  emitPartialTokens: true,
  emitPartialValues: true,
  paths: ['$.edits.*.oldText', '$.edits.*.newText'],
  keepStack: false,
});
```

Both `emitPartialTokens` and `emitPartialValues` are required: `emitPartialValues` alone only surfaces string values at parse events triggered by structural tokens (e.g. the closing `"`), so a growing `oldText`/`newText` string would not be visible mid-value. `emitPartialTokens: true` makes the parser emit in-progress string tokens as characters stream in, which is what drives the progressive `-`/`+` line reveal.

In the `onValue` callback (`{ value, key, stack }`), determine:

- The edit index from the stack entry whose key is numeric (the element inside `edits`).
- Whether this is `oldText` or `newText` from the current `key`.
- The partial/complete string from `value`.

Maintain an internal sparse array of `{ oldText: string; newText: string }` objects (default `''`), update the appropriate field with the latest `value` (partial values overwrite previous partials for that same index+field — `@streamparser/json` emits growing prefixes), and re-compute `markdown` via the shared renderer.

Error handling:

- Wrap `parser.write(jsonDelta)` in `try/catch`; on throw, set an internal `errored` flag and make future `write` calls no-ops. Do not rethrow.
- Also attach `parser.onError = () => { errored = true; }` so parser-internal errors are swallowed without escaping.

`dispose()`:

- Call `parser.end()` inside a `try/catch` and null out the parser reference. Guarded by a `disposed` flag so second and later calls are no-ops. Must not mutate `markdown`.

Expose `markdown` as a getter over an internal string field so the property in the returned object reflects the latest rebuild without extra plumbing.

**Verify:** `cd client && npx vitest run src/lib/edit-diff.test.ts` — all `createEditDiffStreamer` tests pass, including the chunk-by-chunk equivalence test and the malformed-JSON test.
**Status:** done

### Step 3: Wire edit-specific rendering into `ToolCall.svelte`

Edit `client/src/lib/components/ToolCall.svelte`:

1. Add imports:
   - `import TextBlock from './TextBlock.svelte';`
   - `import { buildEditDiffMarkdown, createEditDiffStreamer, type EditArgs } from '$lib/edit-diff.js';`
2. Add a derived boolean `isEdit = $derived(toolName === 'edit')`.
3. Add streaming-diff state used only when `isEdit`:
   - `let streamer: ReturnType<typeof createEditDiffStreamer> | undefined = $state();`
   - `let streamerWritten = 0;` (plain local, not `$state` — tracks how many chars of `content.text` have been fed in).
   - `let streamingMarkdown = $state('');`
   - A `$effect` that, while `isEdit && streaming` and `content.text` is non-empty:
     - Lazily creates `streamer` on first use.
     - Feeds the suffix `content.text.slice(streamerWritten)` via `streamer.write(...)`, advances `streamerWritten`, and sets `streamingMarkdown = streamer.markdown`.
     - Cleanup (effect return): when `streaming` transitions to false, call `streamer?.dispose()` and set `streamer = undefined`, `streamerWritten = 0`.
4. Derive the finalized markdown when not streaming: `finalizedMarkdown = $derived(isEdit && content.args ? buildEditDiffMarkdown(content.args as EditArgs) : '')`.
5. Derive the effective edit markdown to display: `editMarkdown = $derived(isEdit ? (streaming && content.text ? streamingMarkdown : finalizedMarkdown) : '')`.
6. Render logic inside the existing `{#if expanded}` block:
   - When `isEdit && editMarkdown`, replace the `Arguments` `StreamingCollapsible` with a `<TextBlock text={editMarkdown} streaming={streaming && !isCompleted} />` inside a `.tool-section` (no section label).
   - Leave the `Result` section unchanged.
   - When `!isEdit`, keep the existing Arguments/Result rendering exactly as today.

Auto-expand/collapse (ThinkingBlock pattern):

- Change `let expanded = $state(false)` to keep its initial `false` but add a `$effect` applied only when `isEdit`:

  ```ts
  $effect(() => {
    if (!isEdit) return;
    if (streaming || inProgress) {
      expanded = true;
    } else {
      expanded = false;
    }
  });
  ```

- The manual click handler stays as-is; matching `ThinkingBlock`'s pattern, the user can toggle mid-stream and the next reactive tick reasserts, which is acceptable.

Non-edit tool calls must be unaffected: none of the new state, effects, or branches run when `isEdit` is false. Verify by reading the diff — the existing `argsText`, `resultText`, and header logic remain untouched.

**Verify:** `cd client && npx svelte-check --tsconfig ./tsconfig.json` passes. `cd client && npx vitest run` — all tests still pass. Manual smoke: load a finalized session containing an `edit` tool call and confirm it renders as a diff block; run a new edit and confirm the diff streams in while expanded, then the block collapses on completion. `read`/`write`/`bash` tool calls render identically to before.
**Status:** done
