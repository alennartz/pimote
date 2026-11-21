# DR-093: Align built-in editor themes with the VS Code ports they name

## Status

Accepted

Supersedes the `meta` consequence of DR-092.

## Context

Every built-in theme except the two house palettes takes its colors from a named VS Code theme. Nothing checked whether the editor colors it published matched that source. An audit of ten themes against pinned revisions of their ports found 298 of 500 syntax tokens and 99 of 140 editor surface roles rendering a different color than the port renders for the same construct.

Two model gaps caused much of the drift.

Markdown marks (`#`, list bullets, quote marks, emphasis marks, backticks, link brackets) are `processingInstruction` in Lezer, which the editor mapped to `meta`. A theme therefore colored punctuation with the structure scope, and `editor.syntax.meta` carried a paint meaning it never had. DR-092 called this out as intended.

Headings collapsed to one scope. Lezer emits six heading levels and the ports color each level separately, so a single `markup.heading` could not express the source palette.

The rest came from Pimote painting roots and prose constructs that the ports leave at the editor foreground, and from solid surface fills where the ports use translucent overlays.

## Decision

Add two scope families and make children inherit their nearest parent scope.

- `markup.heading.1` to `markup.heading.6` refine `markup.heading`.
- `markup.punctuation` covers prose marks. It inherits `markup`.
- A child now falls back to its nearest parent scope, then to its root. `markup.heading.3` inherits `markup.heading`, not `markup`.
- CodeMirror maps `heading1` to `heading6` and `processingInstruction` to the new scopes, and gives `markup.italic` and `markup.bold` real font styles so emphasis survives without a color.

Built-in themes follow four rules when adopting a port value.

- Adopt the color of the rule the port writes for that construct. A rule that targets a scope VS Code never emits does not count, such as `beginning.punctuation.definition.list.markdown`.
- Take Pimote's value when the port is silent. VS Code's generic defaults for cursor, active line number, bracket match, and gutter carry no palette information.
- Take Pimote's value when the port's color fails the theme audit. A theme keeps readable syntax rather than copying a low-contrast entry.
- Paint a root the port never paints with the editor foreground.

A search match becomes a filled highlight, since every port fills `editor.findMatchBackground` and Pimote drew an underline. The audit requires the fill to stand apart from the editor background at 1.2:1, the same threshold as a diff surface. Diff surfaces keep Pimote's values because the chat diff blocks consume them, not only the editor.

`markup.underline.link` keeps a color distinct from the body markup in every theme. The ports that leave link text at the foreground made links invisible as links, and Pimote marks them.

## Consequences

- Themes state prose per heading level and per mark, which costs six more optional scopes and one punctuation scope.
- A theme file that sets only `markup.heading` still colors every heading, so published extension and user themes keep working.
- `meta` no longer carries punctuation, and the editor foreground reaches marks through `markup.punctuation` instead.
- The audit now measures the search fill against the background rather than treating it as a marker stroke.
- Port defaults that the audit rejects are documented in the commit that adopts the port, so a later reader can tell a deliberate exception from an oversight.

## Rejected alternatives

Copying every port value without the audit gate would have produced built-in themes with syntax below 3:1, including Catppuccin Latte's peach and yellow headings.

Adopting VS Code's generic defaults would have replaced palette colors with the editor's own chrome grays, which say nothing about the theme.

Adding font-style tokens for comments and other constructs was outside the audit, which compared colors only.
