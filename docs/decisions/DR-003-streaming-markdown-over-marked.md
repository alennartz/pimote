# DR-003: streaming-markdown (smd) for incremental markdown rendering

## Status

Accepted

## Context

The web client re-parsed the full markdown document via `marked` + DOMPurify on a debounced interval during streaming. Every time structural elements completed (code blocks, lists, emphasis markers), the parser produced a different DOM tree, causing visible layout shifts. The streaming→finalized transition also replaced the entire DOM. Multiple mitigation strategies were tried (debounce tuning, height-locking, pre-rendered tail for unstyled deltas) but the root cause — full-document re-parse of structurally unstable partial markdown — couldn't be eliminated within that model.

## Decision

Replaced `marked` + DOMPurify with `streaming-markdown` (smd), a 3kB zero-dependency incremental parser that only ever appends DOM nodes. smd's append-only model eliminates layout shifts by construction rather than mitigation. A custom renderer wraps smd's default to hook highlight.js on code block close and allowlist URL schemes (replacing DOMPurify's blanket sanitization).

**Rejected alternatives:**

- **Smarter tricks with marked** (height-locking, character-level append, reduced re-parse frequency) — diminishes jumpiness but never eliminates it. High effort for a partial fix that still fights the fundamental problem.
- **Plain text during streaming, markdown on finalize** — eliminates jumpiness completely but loses all formatting during streaming. Too large a visual regression.
- **`svelte-streamdown`** — native Svelte 5, batteries-included, but still re-parses the full document each tick with memoization. Heavier dependency tree for the same fundamental approach.
- **`@incremark/svelte`** — true O(n) incremental with excellent benchmarks, but v0.3.x with thin English docs. Too immature for production use.

## Consequences

- Layout shifts during streaming are eliminated — text only ever appends, never restructures.
- `marked` and `DOMPurify` are removed as dependencies. DOMPurify's blanket HTML sanitization is replaced by smd's DOM-building model (createElement/createTextNode, no innerHTML) plus targeted URL scheme allowlisting in `set_attr`. This is narrower than DOMPurify's coverage but sufficient given smd never interprets raw HTML strings.
- smd handles both streaming and finalized rendering paths (the initial brainstorm considered keeping marked for finalized messages, but smd handles both cleanly with no reason to maintain two renderers).
- Syntax highlighting depends on smd's `end_token` callback — if smd's renderer API changes, the highlight.js integration breaks. Acceptable given the library's small, stable surface.
