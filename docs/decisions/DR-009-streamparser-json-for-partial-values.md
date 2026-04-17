# DR-009: `@streamparser/json` for incremental edit-args parsing

## Status

Accepted

## Context

The `edit`-tool diff view (see DR-008) needs to surface `oldText` and `newText` string values character-by-character as they stream in, so the user sees `-`/`+` lines building up in real time rather than appearing all at once when the args JSON closes. This requires a parser that:

1. Emits string values _while they're still being written_, not only on the closing `"` token.
2. Lets us subscribe to specific JSON paths (`$.edits.*.oldText`, `$.edits.*.newText`) so we don't process structural scaffolding.
3. Handles JSON escape sequences (`\"`, `\\`, `\uXXXX`, embedded newlines) correctly without silently corrupting user-visible text.

## Decision

Use `@streamparser/json` with `{ emitPartialValues: true, emitPartialTokens: true, paths: ['$.edits.*.oldText', '$.edits.*.newText'], keepStack: false }`.

Both `emitPartialValues` **and** `emitPartialTokens` are required: `emitPartialValues` alone only surfaces string values at parse events triggered by structural tokens (closing `"`), so a growing string would not be visible mid-value. `emitPartialTokens` makes the parser emit in-progress string tokens as characters stream in — that's what drives the progressive `-`/`+` line reveal.

**Rejected alternatives:**

- **`partial-json`** (promplate): purpose-built for LLM partial output and has a simpler API, but it re-parses the entire accumulated buffer on every delta and returns a fresh parse result. To detect _what changed_, we'd have to diff successive parse results ourselves. `@streamparser/json` is push-based, filters by JSONPath, and delivers changes via `onValue` callbacks without any diffing on our side.
- **Hand-rolled regex / manual state machine** over the raw JSON text: rejected as fragile. Getting escape handling right (`\"`, `\\`, `\uXXXX`, `\n` inside strings, surrogate pairs) is easy to botch in ways that silently corrupt output — the kind of bug that slips past unit tests and shows up months later as a garbled diff on some weird input. A spec-compliant streaming parser gets all of this for free.

## Consequences

- One more small runtime dependency in the client bundle. No dependencies of its own, browser-safe.
- The path filter (`$.edits.*.oldText`, `$.edits.*.newText`) tightly couples the parser to the current edit-args shape. If the edit tool's args schema changes (e.g., a different field name, or a new nested structure), the path list has to be updated in lockstep. Caught at test time by `edit-diff.test.ts`'s byte-identity assertion between streaming and finalized output.
- If we ever want a similar streaming transform for another tool (`write`, `bash`, etc.), the same library and pattern apply — the choice is not edit-specific.
- Parser errors (malformed JSON mid-stream — shouldn't happen for well-formed model output) are swallowed: `markdown` stops advancing and the component falls back to the finalized-args view at `message_end`. We deliberately do not surface these to the user.
