# DR-092: TextMate root groups for editor syntax tokens

## Status

Accepted

## Context

`editor.syntax` was a flat union of 54 roles. Every theme had to fill all 54, so each built-in palette repeated a long mapping table and still left most roles on the foreground color. The union had no parent relation, which meant a language construct and its closest neighbors shared nothing: adding a color for comments could not color doc comments, and a theme that wanted one color for all keywords had no way to say so.

Syntax highlighting formats solve this with a small fixed taxonomy whose finer entries inherit from a coarser parent. TextMate defines eleven root groups and states that a minimal theme paints ten of them. Lezer tags, which the CodeMirror editor in this repository already uses, inherit from parent tags with exactly this fallback. CodeMirror, Highlight.js, and any future language integration can therefore agree on roots and stay silent about the rest.

We considered the LSP semantic token types. They classify code precisely, but they carry no vocabulary for prose or diffs: headings, emphasis, links, inserted lines, and deleted lines have no LSP type. They also add a second taxonomy to learn alongside TextMate naming that the highlighting grammars already use.

## Decision

`editor.syntax` uses the TextMate root groups: `comment`, `constant`, `entity`, `invalid`, `keyword`, `markup`, `meta`, `storage`, `string`, `support`, and `variable`. A standalone theme requires the ten painted roots. `meta` groups structure rather than text, so it stays optional and defaults to the editor foreground.

Child scopes are optional overrides, drawn from the TextMate naming conventions, plus `markup.strikethrough`, `markup.inserted`, `markup.deleted`, and `markup.changed` from the VS Code scope conventions. A child that a theme does not set takes its root color at resolution time. The catalog resolves every scope, so consumers read one complete map and never compute inheritance themselves.

Theme files that use the retired flat role names still load. Each name maps to its nearest scope in one table, so `function` becomes `entity.name.function` and `inserted` becomes `markup.inserted`. Coarse names land on roots, which keeps a migrated standalone file complete.

The theme audit checks contrast for each painted root and for each child whose resolved color departs from its root. It also verifies that the chat code-block stylesheet references only editor properties the catalog publishes.

## Consequences

- A theme can express its syntax palette in ten entries and refine it where the language matters.
- Root and child colors reach the editor through Lezer tags and Highlight.js classes; markup scopes carry the prose and diff colors that code-only taxonomies cannot name.
- `meta` is the one scope without a paint requirement, which keeps punctuation and embedded structure on the editor foreground.
- Retired role names resolve through one alias table, so published extension themes and user files survive the change.
- The audit reports a theme that paints a child with insufficient contrast, and reports a stylesheet property that no scope publishes.
