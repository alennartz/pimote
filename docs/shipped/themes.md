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
      "ui": { "background": "#111827" },
      "editor": { "surface": {}, "syntax": {}, "terminal": {} }
    }
  ]
}
```

A standalone theme defines every `ui` token, editor surface role, syntax role, and ANSI terminal slot. A child theme can set `extends` to any available theme and override selected values. A `palette` maps reusable names to CSS Color 4 literals. A value can be a literal or `{ "palette": "name" }`.

The UI tokens are `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `warning`, `warning-foreground`, `border`, `input`, `ring`, `chart-1` through `chart-5`, `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, `sidebar-ring`, `status-active`, `status-streaming`, `status-connected`, `status-error`, `status-reconnecting`, `surface-sunken`, `surface-raised`, `surface-subtle`, `surface-hover`, the error, skill, bash, and custom callout tokens, `link`, `link-hover`, `avatar-bg`, `avatar-fg`, and `shadow-color`.

Editor surface roles are `background`, `foreground`, `selection`, `cursor`, `active-line`, `gutter-background`, `gutter-foreground`, `line-number`, `active-line-number`, `matching-bracket`, and `search-match`. Syntax roles cover comments, names, declarations, operators, strings, literals, markup, Markdown, and change states. Terminal slots are the standard eight ANSI colors and their eight bright variants. Extended ANSI indices retain their standard mapping.

IDs are global. Use a stable `publisher/theme-name` ID. The eight built-ins are `pimote/light`, `pimote/dark`, `dracula/dracula`, `tokyo-night/tokyo-night`, `nord/nord`, `gruvbox/dark`, `solarized/light`, and `catppuccin/mocha`.

## Sources and validation

Pimote loads built-ins, extension files in deterministic discovery order, then `$XDG_CONFIG_HOME/pimote/themes.json` (normally `~/.config/pimote/themes.json`). The first valid definition for an ID wins. Extension and user definitions cannot replace a built-in ID. Invalid entries produce diagnostics and do not block other sources. An invalid user edit leaves its last valid contribution active. Cycles, missing inheritance bases, unknown palette swatches, missing roles, and invalid CSS colors reject only the affected theme. Contrast is not checked.

## Defaults and profiles

Set the native `defaultTheme` field in `config.json`. It defaults to `pimote/light` and applies immediately after a native config save. A profile's `selectedThemeId` is either a theme ID or `null`; `null` follows the server default. If a saved theme or configured default is unavailable, Pimote renders Pimote Light while retaining the saved ID.

The PWA requests the catalog over `get_theme_catalog`. Appearance previews stay local until **Save theme** sends `set_theme`. **Cancel** restores the saved selection. A saved choice applies to every connection using the same username.
