# streaming-code-highlight-smoke

PWA-side smoke for the `streaming-code-highlight` topic — the `write` tool
visualization (`ToolCall.svelte` → `WriteFileBlock.svelte`) and the markdown
rendering path.

## What it verifies

Fabricates one pi session on disk containing four **completed** `write` tool
calls (code + markdown, short + long), boots `bin/pimote.js` in a sandbox, opens
the session in the PWA via `agent-browser`, and asserts the **finalized** render
contracts:

1. **Mode routing by extension** — `.ts` → code mode
   (`<pre><code class="hljs">`); `.md` → markdown mode (rendered via TextBlock).
2. **Copy yields RAW source verbatim — BOTH modes** (precondition a). Captured
   by overriding `navigator.clipboard.writeText` (headless clipboard reads are
   unreliable).
3. **Show-more/collapse wrapper bounds long files — BOTH modes** (precondition
   b): a >20-line write shows "Show more…" and clamps the body.
4. **Code mode carries real hljs span markup** and preserves the source text.
5. **Markdown mode renders markdown** (headings/lists as HTML) and highlights an
   inner fenced ```code block.

## Harness limitation

The driver fabricates sessions on disk, so it observes the **settled** state
only. It does **not** exercise the streaming-only behaviors —
auto-expand-while-streaming / auto-collapse-on-completion, and mid-stream
highlighting in the write view. Those require a live token stream; their logic
is covered by `client/src/lib/*.test.ts`
(`code-highlight.test.ts`, `write-content.test.ts`, `smd-renderer.test.ts`). See
`docs/manual-tests/streaming-code-highlight.md` → Harness Limitations.

## Invocation

```bash
npm run build
node tools/manual-test/streaming-code-highlight-smoke/streaming-code-highlight-smoke.mjs
```

Set `SCH_SHOT=/path/out.png` to write the coherence screenshot outside the
(auto-deleted-on-pass) sandbox.

**Inputs:** none. Builds a fresh sandbox under `os.tmpdir()` (its own `HOME` +
XDG dirs), fabricates + seeds the pi session JSONL, and boots pimote on a free
local port.

**Outputs:** per-test ✓/✗ lines on stdout + a `write-blocks.png` coherence
screenshot in the sandbox (or `$SCH_SHOT`); non-zero exit on any failure. On
failure the sandbox is preserved and its path (plus a `pimote.log` tail) is
printed.

**Prerequisites:** workspaces built (`npm run build`), `agent-browser` on PATH,
writable `os.tmpdir()`. Tracks and kills only the child PID it spawns — no
pattern-based `pkill`. No real LLM, speechmux, or network required.
