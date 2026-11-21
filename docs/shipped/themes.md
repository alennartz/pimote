# Themes

Pimote themes pair the dashboard palette with editor and terminal colors. The selected theme is stored per Pimote username. A user can follow the server default or save an override.

## Canonical implementation

The canonical token names live in `shared/src/themes.ts`. The mandatory tokens and fallback graph live in `shared/src/design-tokens.ts`. Tools and theme files must use those definitions instead of copying token lists or fallback edges. Installed packages also ship the runtime artifacts at `shared/dist/themes.js` and `shared/dist/design-tokens.js`.

## Theme files

User and extension files use one versioned JSON document:

```json
{
  "version": 1,
  "themes": [
    {
      "id": "publisher/theme-name",
      "name": "Theme Name",
      "colorScheme": "dark",
      "palette": { "ink": "#f8f8f2" },
      "ui": { "foreground": { "palette": "ink" } },
      "editor": { "surface": {}, "syntax": {}, "terminal": {} }
    }
  ]
}
```

The example is intentionally abbreviated. It is not a loadable standalone theme. A standalone theme must state every mandatory token listed below, and may omit the rest. A child theme can set `extends` to any available theme and override selected values. A `palette` maps reusable names to CSS Color 4 literals. A value can be a literal or `{ "palette": "name" }`.

### Mandatory tokens

One graph declares all 142 tokens and the 108 edges between them. A token is either mandatory, with no fallback, or an alias of exactly one other token. Every chain ends at a mandatory token and no chain repeats a token. The graph is `shared/src/design-tokens.ts`.

A standalone theme states these 34 tokens:

| Namespace         | Mandatory tokens                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui`              | `background`, `foreground`, `primary`, `primary-foreground`, `border`, `destructive`, `warning`, `warning-foreground`, `status-connected`, `status-streaming-on-primary`, `status-reconnecting-on-primary`, `shadow-color` |
| `editor.surface`  | `background`, `foreground`, `diff-addition-background`, `diff-deletion-background`                                                                                                                                         |
| `editor.syntax`   | the ten painted roots named below                                                                                                                                                                                          |
| `editor.terminal` | `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`                                                                                                                                                      |

Each of these anchors guards a role no other token can stand in for: warning text needs its own foreground, a selected session chip needs its own status glyph color, and a diff surface needs its own separation from the editor background.

Depth counts the edges between a token and its nearest mandatory token. On the surface ladder, `background` is depth 0, `card` 1, `surface-subtle` 2, `surface-hover` 3, `accent` 4, and `sidebar-accent` 5. A theme's level is the deepest token it states, reported per namespace.

### UI roles

A `ui` map holds any of `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `warning`, `warning-foreground`, `border`, `input`, `ring`, `chart-1`, `chart-2`, `chart-3`, `chart-4`, `chart-5`, `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, `sidebar-ring`, `status-active`, `status-streaming`, `status-connected`, `status-error`, `status-reconnecting`, `surface-sunken`, `surface-raised`, `surface-subtle`, `surface-hover`, `error-accent`, `error-surface`, `error-foreground`, `error-avatar-fg`, `skill-accent`, `skill-surface`, `skill-foreground`, `skill-foreground-hover`, `bash-accent`, `custom-accent`, `custom-surface`, `custom-foreground`, `custom-foreground-hover`, `link`, `link-hover`, `avatar-bg`, `avatar-fg`, and `shadow-color`. An omitted role takes the value of the token it falls back to:

- `card` falls back to `background`. `popover`, `secondary`, `muted`, and `sidebar` fall back to `card`.
- `surface-sunken` falls back to `background`. `surface-raised` and `surface-subtle` fall back to `card`. `surface-hover` falls back to `surface-subtle`. `accent` falls back to `surface-hover`. `sidebar-accent` falls back to `accent`.
- The `*-foreground` roles fall back to `foreground`, apart from the mandatory `primary-foreground` and `warning-foreground`, `sidebar-primary-foreground` to `primary-foreground`, `sidebar-accent-foreground` to `accent-foreground`, `avatar-fg` to `muted-foreground`, and `error-avatar-fg` to `error-foreground`.
- `input` and `sidebar-border` fall back to `border`. `ring` and `link` fall back to `primary`. `link-hover` falls back to `link`. `sidebar-primary` falls back to `primary`. `sidebar-ring` falls back to `ring`.
- `status-active` falls back to `primary`. `status-streaming` falls back to `status-connected`. `status-reconnecting` falls back to `warning`. `status-error` falls back to `destructive`. Both `*-on-primary` roles are mandatory.
- `chart-1` through `chart-5` fall back to `primary`, so an unstated chart draws every series in the accent color.
- `error-accent` falls back to `destructive`. `skill-accent` and `bash-accent` fall back to `status-connected`. `custom-accent` falls back to `primary`.
- `error-surface`, `skill-surface`, and `custom-surface` fall back to `surface-subtle`. `avatar-bg` falls back to `muted`.

Use `status-connected` and `status-streaming` for success, `status-reconnecting` and `warning` for attention, `status-error` and `destructive` for errors, and `status-active` for the active accent. Use the `*-on-primary` roles for status icons on selected session chips. These UI roles are separate from the editor's ANSI palette. Themes can reuse palette swatches across them.

### Editor roles

The `editor.surface` map states `background`, `foreground`, `diff-addition-background`, and `diff-deletion-background`, and may state `selection`, `selection-foreground`, `cursor`, `active-line`, `gutter-background`, `gutter-foreground`, `line-number`, `active-line-number`, `matching-bracket`, and `search-match`. Unstated roles follow the dashboard: `selection` falls back to `ui.primary`, `selection-foreground` to `ui.primary-foreground`, `cursor` to `ui.foreground`, `active-line` to `ui.surface-hover`, `gutter-foreground` and `line-number` to `ui.muted-foreground`, `matching-bracket` to `ui.ring`, and `search-match` to `ui.warning`. `gutter-background` falls back to the editor background, and `active-line-number` to `line-number`.

The `editor.syntax` map uses the TextMate root groups. A standalone theme requires every root except `meta`, which carries structure rather than paint and defaults to the editor foreground:

`comment`, `constant`, `entity`, `invalid`, `keyword`, `markup`, `storage`, `string`, `support`, `variable`.

Child scopes are optional. An unset child takes its nearest parent scope, or its root color when it has none. `markup.heading.1` to `.6` refine `markup.heading`, and `markup.punctuation` covers the prose marks (`#`, list bullets, quote marks, emphasis marks, backticks, and link brackets):

- `comment`: `comment.documentation`
- `constant`: `constant.numeric`, `constant.language`, `constant.character.escape`, `constant.other`
- `entity`: `entity.name.function`, `entity.name.function.macro`, `entity.name.type`, `entity.name.tag`, `entity.name.namespace`, `entity.name.label`, `entity.other.attribute-name`
- `keyword`: `keyword.control`, `keyword.operator`
- `markup`: `markup.heading`, `markup.heading.1` to `markup.heading.6`, `markup.punctuation`, `markup.list`, `markup.quote`, `markup.italic`, `markup.bold`, `markup.underline.link`, `markup.raw`, `markup.strikethrough`, `markup.inserted`, `markup.deleted`, `markup.changed`
- `storage`: `storage.type`, `storage.modifier`
- `string`: `string.quoted`, `string.regexp`, `string.other`
- `support`: `support.function`, `support.type`, `support.constant`, `support.variable`
- `variable`: `variable.parameter`, `variable.other`, `variable.other.property`, `variable.other.enum-member`, `variable.language`

The editor renders each scope through CodeMirror tags or a Highlight.js class, so a theme that sets only roots colors every language alike. Theme files that use the retired flat role names still load; each name maps to its nearest scope, such as `function` to `entity.name.function` and `inserted` to `markup.inserted`.

The `editor.terminal` map states `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, and `white`. Each `bright-` slot falls back to its base slot. Extended 256-color ANSI indices retain their standard mapping.

## Normalizing a theme file

A theme states only what it chooses and omits the rest, so a file that states a role and then repeats its fallback value is longer than it needs to be. The normalizer removes every statement whose removal leaves the resolved palette unchanged:

```sh
npm run theme:normalize -- ~/.config/pimote/themes.json
npm run theme:normalize -- theme.json --write
npm run theme:normalize -- theme.json --check
npm run theme:normalize -- theme.json --report
```

`--write` rewrites the file, and `--check` exits with failure when a file is not minimal. `--report` prints each theme's level per namespace, the count of stated tokens at each depth, and the roles whose fallback parent it leaves unstated. `--expand` prints every resolved token instead. The normalizer refuses to rewrite a file that has a diagnostic, and its output is stable, so a second run changes nothing.

## Sources and validation

Pimote loads built-ins, extension files in deterministic discovery order, then `$XDG_CONFIG_HOME/pimote/themes.json` (normally `~/.config/pimote/themes.json`). The first valid definition for an ID wins. Extension and user definitions cannot replace a built-in ID. Invalid entries produce diagnostics and do not block other sources. An invalid user edit leaves its last valid contribution active. Cycles, missing inheritance bases, unknown palette swatches, missing mandatory tokens, and invalid CSS colors reject only the affected theme. The runtime catalog does not enforce contrast. Run `npm run audit:themes` to check the current consumer pairings.

The ten built-ins are `pimote/light`, `pimote/dark`, `pimote/dracula`, `pimote/tokyo-night`, `pimote/nord`, `pimote/gruvbox-dark`, `pimote/solarized-light`, `pimote/catppuccin-mocha`, `pimote/catppuccin-latte`, and `pimote/everforest-medium-dark`. Their IDs use `pimote` as publisher, regardless of palette origin, in the stable `publisher/theme-name` form. Previous IDs remain accepted in native defaults, saved selections, and inheritance references.

## Manager workflows

A manager can discover `pimote_set_theme` to change a known user's saved selection. The tool rejects an unknown or ambiguous user and never creates a profile. A manager can discover `pimote_theme_demo` to host every valid theme in a draft file as a static visual preview.

Audit and normalization remain package scripts. Run them from any working directory with the installed package root:

```sh
node <package-root>/server/dist/theme-audit-cli.js --file /absolute/path/themes.json --json
node <package-root>/server/dist/theme-normalize-cli.js --write --json /absolute/path/themes.json
```

The audit reports only themes from the supplied file while using built-ins as inheritance bases. Normalization writes only when the file has no diagnostics and preserves the resolved palette.

## Defaults and profiles

Set the native `defaultTheme` field in `config.json`. It defaults to `pimote/light` and applies immediately after a native config save. A profile's `selectedThemeId` is either a theme ID or `null`; `null` follows the server default. If a saved theme or configured default is unavailable, Pimote renders Pimote Light while retaining the saved ID.

The PWA requests the catalog over `get_theme_catalog`. Appearance previews stay local until **Save theme** sends `set_theme`. **Cancel** and mobile **Close** restore the saved selection. A saved choice applies to every connection using the same username.

## Extension registration

Extensions register read-only JSON files with `context.themes.registerFile(path)`. Relative paths resolve from the registering extension entry, and a leading `~` resolves from the home directory. Pimote reads registered files during startup and extension reload. It does not edit them.
