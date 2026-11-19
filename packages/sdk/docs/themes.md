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

The file has `version: 1` and a `themes` array. Each theme has a stable `id`, `name`, `colorScheme` (`light` or `dark`), complete `ui`, `editor.surface`, `editor.syntax`, and `editor.terminal` maps. A theme can define a `palette` of CSS Color 4 literals, use `{ "palette": "name" }` references, and extend another available theme with `extends`. Child themes inherit parent roles and swatches.

Use IDs such as `publisher/theme-name`. Built-in IDs are reserved. Pimote loads built-ins first, then extension files in host discovery order, then the user's `~/.config/pimote/themes.json`. The first valid duplicate wins. Invalid files or themes produce diagnostics and do not stop other extensions. Color contrast is not enforced.

See [`docs/shipped/themes.md`](../../../docs/shipped/themes.md) for the complete token lists, profile defaults, and PWA behavior.
