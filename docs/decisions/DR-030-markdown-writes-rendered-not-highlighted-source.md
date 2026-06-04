# DR-030: Render `.md`/`.markdown` writes as rendered markdown, not highlighted source

## Status

Accepted

## Context

The `write` tool view (see DR-029) shows a file's `content` as it streams. For
code files the obvious treatment is syntax-highlighted source. For markdown
files (`.md`/`.markdown`) there are two coherent options: show the source
colorized as hljs `markdown`-language text, or route the content through the
app's existing smd markdown pipeline (`TextBlock.svelte`) and show _rendered_
output.

## Decision

When the `write` path extension is `.md`/`.markdown`, render the extracted
`content` stream through the smd markdown pipeline (`TextBlock`) — rendered
output, not source. `WriteFileBlock.svelte` picks the mode from the
path-inferred language (`markdown` → markdown mode, everything else → code
mode).

The reasons: it's the same append-only streaming pipeline already used
everywhere else, rendered markdown is this app's core aesthetic, and any fenced
code blocks _inside_ the document get the new incremental fenced-code
highlighting (DR-029) for free.

Two refinements are **hard preconditions** on this choice, not nice-to-haves —
they exist to claw back the useful properties that rendering otherwise loses,
and they apply in **both** modes (code and markdown):

1. **The copy button copies raw source verbatim** — the literal `content` bytes
   (whitespace, frontmatter, raw HTML, `#`/`*` characters), never the
   rendered/highlighted text.
2. **A show-more/collapse wrapper bounds long files** so a long rendered doc
   doesn't blow out the transcript.

**Rejected alternatives:**

- **Treat `.md` as hljs `markdown`-language source** (colorized but unrendered).
  A consistency win — every write would render the same way (highlighted
  source) — but it loses the rendered-markdown aesthetic that is central to the
  app, and it's strictly less useful for glancing at a doc taking shape.
- **A source⇄rendered toggle.** More implementation work and UI surface for
  marginal benefit; not worth it for v1.

## Consequences

- Rendering hides literal bytes: whitespace, frontmatter, raw HTML, and the
  `#`/`*` markdown characters are not visible in markdown mode. Accepted because
  watching a write stream is about glanceability, not byte auditing — and the
  copy-raw-source button preserves byte access when it's actually needed.
- The two preconditions (copy-raw, collapse-both-modes) are load-bearing: if a
  future change makes copy yield rendered text or drops the collapse wrapper on
  the markdown path, the trade-off this decision accepted no longer holds. They
  were carried as explicit manual-test cases for this reason.
- The collapsed-height clamp and the "Show more… (N lines)" count are derived
  from code-mode line metrics and source line counts, so on the markdown path
  the collapse point is an approximation of rendered height. Cosmetic only — the
  collapse still functions and bounds long files.
- Component chrome (mode routing, copy-raw, collapse, auto-expand/collapse) is
  not unit-tested, following the `edit` precedent (only the pure logic modules
  carry tests); these guarantees are verified in the manual-test phase.
