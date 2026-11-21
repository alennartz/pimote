# Themes

Pimote themes pair the dashboard palette with editor and terminal colors. The selected theme is stored per Pimote username. A user can follow the server default or save an override.

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

The example is intentionally abbreviated. It is not a loadable standalone theme. A standalone theme must define every required role listed below. The optional `status-streaming-on-primary` and `status-reconnecting-on-primary` roles default to `primary-foreground` when omitted. A child theme can set `extends` to any available theme and override selected values. A `palette` maps reusable names to CSS Color 4 literals. A value can be a literal or `{ "palette": "name" }`.

### UI roles

A standalone `ui` map defines `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `warning`, `warning-foreground`, `border`, `input`, `ring`, `chart-1`, `chart-2`, `chart-3`, `chart-4`, `chart-5`, `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, `sidebar-ring`, `status-active`, `status-streaming`, `status-connected`, `status-error`, `status-reconnecting`, `surface-sunken`, `surface-raised`, `surface-subtle`, `surface-hover`, `error-accent`, `error-surface`, `error-foreground`, `error-avatar-fg`, `skill-accent`, `skill-surface`, `skill-foreground`, `skill-foreground-hover`, `bash-accent`, `custom-accent`, `custom-surface`, `custom-foreground`, `custom-foreground-hover`, `link`, `link-hover`, `avatar-bg`, `avatar-fg`, and `shadow-color`. It can also define the optional `status-streaming-on-primary` and `status-reconnecting-on-primary` roles.

Use `status-connected` and `status-streaming` for success, `status-reconnecting` and `warning` for attention, `status-error` and `destructive` for errors, and `status-active` for the active accent. Use the `*-on-primary` roles for status icons on selected session chips. These UI roles are separate from the editor's ANSI palette. Themes can reuse palette swatches across them.

### Editor roles

The `editor.surface` map defines `background`, `foreground`, `selection`, `selection-foreground`, `cursor`, `active-line`, `gutter-background`, `gutter-foreground`, `line-number`, `active-line-number`, `matching-bracket`, `search-match`, `diff-addition-background`, and `diff-deletion-background`.

The `editor.syntax` map uses the TextMate root groups. A standalone theme requires every root except `meta`, which carries structure rather than paint and defaults to the editor foreground:

`comment`, `constant`, `entity`, `invalid`, `keyword`, `markup`, `storage`, `string`, `support`, `variable`.

Child scopes are optional. An unset child takes its root color:

- `comment`: `comment.documentation`
- `constant`: `constant.numeric`, `constant.language`, `constant.character.escape`, `constant.other`
- `entity`: `entity.name.function`, `entity.name.function.macro`, `entity.name.type`, `entity.name.tag`, `entity.name.namespace`, `entity.name.label`, `entity.other.attribute-name`
- `keyword`: `keyword.control`, `keyword.operator`
- `markup`: `markup.heading`, `markup.list`, `markup.quote`, `markup.italic`, `markup.bold`, `markup.underline.link`, `markup.raw`, `markup.strikethrough`, `markup.inserted`, `markup.deleted`, `markup.changed`
- `storage`: `storage.type`, `storage.modifier`
- `string`: `string.quoted`, `string.regexp`, `string.other`
- `support`: `support.function`, `support.type`, `support.constant`, `support.variable`
- `variable`: `variable.parameter`, `variable.other`, `variable.other.property`, `variable.other.enum-member`, `variable.language`

The editor renders each scope through CodeMirror tags or a Highlight.js class, so a theme that sets only roots colors every language alike. Theme files that use the retired flat role names still load; each name maps to its nearest scope, such as `function` to `entity.name.function` and `inserted` to `markup.inserted`.

The `editor.terminal` map defines `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `bright-black`, `bright-red`, `bright-green`, `bright-yellow`, `bright-blue`, `bright-magenta`, `bright-cyan`, and `bright-white`. Extended 256-color ANSI indices retain their standard mapping.

## Sources and validation

Pimote loads built-ins, extension files in deterministic discovery order, then `$XDG_CONFIG_HOME/pimote/themes.json` (normally `~/.config/pimote/themes.json`). The first valid definition for an ID wins. Extension and user definitions cannot replace a built-in ID. Invalid entries produce diagnostics and do not block other sources. An invalid user edit leaves its last valid contribution active. Cycles, missing inheritance bases, unknown palette swatches, missing required roles, and invalid CSS colors reject only the affected theme. The runtime catalog does not enforce contrast. Run `npm run audit:themes` to check the current consumer pairings.

The ten built-ins are `pimote/light`, `pimote/dark`, `pimote/dracula`, `pimote/tokyo-night`, `pimote/nord`, `pimote/gruvbox-dark`, `pimote/solarized-light`, `pimote/catppuccin-mocha`, `pimote/catppuccin-latte`, and `pimote/everforest-medium-dark`. Their IDs use `pimote` as publisher, regardless of palette origin, in the stable `publisher/theme-name` form. Previous IDs remain accepted in native defaults, saved selections, and inheritance references.

## Defaults and profiles

Set the native `defaultTheme` field in `config.json`. It defaults to `pimote/light` and applies immediately after a native config save. A profile's `selectedThemeId` is either a theme ID or `null`; `null` follows the server default. If a saved theme or configured default is unavailable, Pimote renders Pimote Light while retaining the saved ID.

The PWA requests the catalog over `get_theme_catalog`. Appearance previews stay local until **Save theme** sends `set_theme`. **Cancel** and mobile **Close** restore the saved selection. A saved choice applies to every connection using the same username.

## Extension registration

Extensions register read-only JSON files with `context.themes.registerFile(path)`. Relative paths resolve from the registering extension entry, and a leading `~` resolves from the home directory. Pimote reads registered files during startup and extension reload. It does not edit them.
