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

The JSON example below is intentionally abbreviated. It is not a loadable standalone theme. A standalone file must define every required role in the following lists. The optional `status-streaming-on-primary` and `status-reconnecting-on-primary` roles default to `primary-foreground` when omitted.

The `ui` map requires `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `warning`, `warning-foreground`, `border`, `input`, `ring`, `chart-1`, `chart-2`, `chart-3`, `chart-4`, `chart-5`, `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, `sidebar-ring`, `status-active`, `status-streaming`, `status-connected`, `status-error`, `status-reconnecting`, `surface-sunken`, `surface-raised`, `surface-subtle`, `surface-hover`, `error-accent`, `error-surface`, `error-foreground`, `error-avatar-fg`, `skill-accent`, `skill-surface`, `skill-foreground`, `skill-foreground-hover`, `bash-accent`, `custom-accent`, `custom-surface`, `custom-foreground`, `custom-foreground-hover`, `link`, `link-hover`, `avatar-bg`, `avatar-fg`, and `shadow-color`. It can also define the optional `status-streaming-on-primary` and `status-reconnecting-on-primary` roles.

The `editor.surface` map requires `background`, `foreground`, `selection`, `selection-foreground`, `cursor`, `active-line`, `gutter-background`, `gutter-foreground`, `line-number`, `active-line-number`, `matching-bracket`, `search-match`, `diff-addition-background`, and `diff-deletion-background`.

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

The `editor.terminal` map requires `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `bright-black`, `bright-red`, `bright-green`, `bright-yellow`, `bright-blue`, `bright-magenta`, `bright-cyan`, and `bright-white`. Extended 256-color ANSI indices retain their standard mapping.

## IDs, sources, and validation

Use IDs such as `publisher/theme-name`. Built-in IDs are reserved. Pimote loads built-ins first, then extension files in host discovery order, then the user's `$XDG_CONFIG_HOME/pimote/themes.json` (normally `~/.config/pimote/themes.json`). The first valid duplicate wins. Invalid files or themes produce diagnostics and do not stop other extensions. Cycles, missing bases, unknown palette swatches, missing required roles, and invalid CSS colors reject only the affected theme. The runtime catalog does not enforce contrast. Run `npm run audit:themes` to check the current consumer pairings.

## User defaults and PWA behavior

The native `defaultTheme` defaults to `pimote/light`. A user's `selectedThemeId` is either a theme ID or `null`; `null` follows the server default. If a saved theme or configured default is unavailable, Pimote renders Pimote Light while retaining the saved ID. The PWA previews locally, **Save theme** sends `set_theme`, and **Cancel** or mobile **Close** restores the saved palette. A saved choice applies to every connection using the same Pimote username.

See [`docs/shipped/themes.md`](../../../docs/shipped/themes.md) for the server catalog and runtime behavior.
