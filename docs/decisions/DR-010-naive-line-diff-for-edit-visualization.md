# DR-010: Naive line-for-line diff rendering for edit tool visualization

## Status

Accepted

## Context

The `edit`-tool diff view needs to display an `oldText` → `newText` pair as a diff. The obvious textbook approach is to run an LCS / Myers-style line diff, detect common lines, and emit a minimal hunk with context — what `git diff` does. That produces the tightest visual representation when the two sides share structure.

The alternative is a naive render: every line of `oldText` becomes a `-` line; every line of `newText` becomes a `+` line; no common-line detection, no context, no hunking.

## Decision

Use the naive line-for-line rendering. `buildEditDiffMarkdown` / `createEditDiffStreamer` split `oldText` and `newText` on `\n` and emit one `- <line>` / `+ <line>` per piece, with no attempt to find common subsequences between the two sides.

The reason this is acceptable is a property of how the `edit` tool is used upstream: pi's system prompt tells the agent to keep `oldText` as small as possible while still being unique. In practice, edits are already trimmed down to the changed region — usually just a few lines, often a single line — so a naive render already looks diff-shaped. A real diff algorithm would spend work finding common lines that by construction aren't there.

**Rejected alternative: real diff algorithm (LCS / Myers).** It would produce tighter output when `oldText`/`newText` share a lot of structure, but:

- The agent rarely produces large, mostly-shared pairs — the scenario where a real diff wins is infrequent in practice.
- Adds a diff library (or a non-trivial implementation) to the client bundle for a feature that renders correctly without it.
- More surface area to get wrong, especially in the streaming path where partial values need to produce output that converges to the finalized rendering. The naive renderer's streaming and finalized paths are trivially byte-identical; a real-diff streaming path would need careful thought to keep the output stable as lines arrive.

## Consequences

- Sub-line (intra-line) changes show as one full `-` line immediately followed by one full `+` line. This is uglier than a word-level or character-level intra-line diff, but still clearly readable.
- Pathologically large edits (big `oldText` + big `newText` that share most of their content) would render as two big blocks with no interleaving — noisy but correct. If the agent ever starts producing edits like this regularly, revisit.
- The streaming and finalized renderers share a single private helper, so they are guaranteed to produce identical output once all partial values are final (required by the plan's no-relayout-at-handoff invariant, tested in `edit-diff.test.ts`).
- If we ever want richer visualization (intra-line highlighting, context-aware hunks), the `edit-diff.ts` module is the single place to change and its tests pin the current contract.
