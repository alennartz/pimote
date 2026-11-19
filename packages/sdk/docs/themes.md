# Theme files for extensions

A process-global Pimote extension can register a read-only theme file:

```ts
import type { PimoteExtension } from '@pimote/sdk/pimote';

const extension: PimoteExtension = (context) => {
  context.themes.registerFile('./themes/night.json');
};

export default extension;
```

`registerFile` accepts a non-empty path. A leading `~` resolves from the home directory. Relative paths resolve from the extension entry module. Pimote reads the file as JSON and does not edit it. Register files while the factory runs. A registration after the factory returns is ignored. Reload creates a fresh registry and drops old registrations.

## File shape

The file has `version: 1` and a `themes` array. Each theme has a stable `id`, `name`, `colorScheme` (`light` or `dark`), complete `ui`, `editor.surface`, `editor.syntax`, and `editor.terminal` maps. A theme can define a `palette` of CSS Color 4 literals, use `{ "palette": "name" }` references, and extend another available theme with `extends`.

The JSON example below is intentionally abbreviated. It is not a loadable standalone theme. A standalone file must define every role in the following lists.

The `ui` map requires `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `warning`, `warning-foreground`, `border`, `input`, `ring`, `chart-1`, `chart-2`, `chart-3`, `chart-4`, `chart-5`, `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, `sidebar-ring`, `status-active`, `status-streaming`, `status-connected`, `status-error`, `status-reconnecting`, `surface-sunken`, `surface-raised`, `surface-subtle`, `surface-hover`, `error-accent`, `error-surface`, `error-foreground`, `error-avatar-fg`, `skill-accent`, `skill-surface`, `skill-foreground`, `skill-foreground-hover`, `bash-accent`, `custom-accent`, `custom-surface`, `custom-foreground`, `custom-foreground-hover`, `link`, `link-hover`, `avatar-bg`, `avatar-fg`, and `shadow-color`.

The `editor.surface` map requires `background`, `foreground`, `selection`, `cursor`, `active-line`, `gutter-background`, `gutter-foreground`, `line-number`, `active-line-number`, `matching-bracket`, and `search-match`.

The `editor.syntax` map requires `comment`, `doc-comment`, `name`, `variable`, `parameter`, `type`, `tag`, `property`, `attribute`, `class`, `label`, `namespace`, `macro`, `constant`, `function`, `built-in`, `keyword`, `control-keyword`, `definition-keyword`, `modifier`, `operator-keyword`, `operator`, `punctuation`, `separator`, `bracket`, `string`, `doc-string`, `character`, `attribute-value`, `number`, `boolean`, `null`, `regexp`, `escape`, `color`, `url`, `content`, `heading`, `content-separator`, `list`, `quote`, `emphasis`, `strong`, `link`, `monospace`, `strikethrough`, `inserted`, `deleted`, `changed`, `invalid`, `meta`, `document-meta`, `annotation`, and `processing-instruction`.

The `editor.terminal` map requires `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `bright-black`, `bright-red`, `bright-green`, `bright-yellow`, `bright-blue`, `bright-magenta`, `bright-cyan`, and `bright-white`. Extended 256-color ANSI indices retain their standard mapping.

## IDs, sources, and validation

Use IDs such as `publisher/theme-name`. Built-in IDs are reserved. Pimote loads built-ins first, then extension files in host discovery order, then the user's `~/.config/pimote/themes.json`. The first valid duplicate wins. Invalid files or themes produce diagnostics and do not stop other extensions. Cycles, missing bases, unknown palette swatches, missing roles, and invalid CSS colors reject only the affected theme. Color contrast is not enforced.

## User defaults and PWA behavior

The native `defaultTheme` defaults to `pimote/light`. A user's `selectedThemeId` is either a theme ID or `null`; `null` follows the server default. If a saved theme or configured default is unavailable, Pimote renders Pimote Light while retaining the saved ID. The PWA previews locally, **Save theme** sends `set_theme`, and **Cancel** or mobile **Close** restores the saved palette. A saved choice applies to every connection using the same Pimote username.

See [`docs/shipped/themes.md`](../../../docs/shipped/themes.md) for the server catalog and runtime behavior.
