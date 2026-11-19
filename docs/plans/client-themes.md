# Plan: Web themes

## Context

Add user-selectable themes to the Pimote PWA, with a paired UI and editor palette. Users will author custom themes through any session, while Pimote extensions can ship read-only theme files. See [the brainstorm](../brainstorms/client-themes.md).

## Architecture

### Impacted Modules

- **Protocol** — Add PWA-specific catalog request/change messages and a theme-selection command. Add the user's selected theme ID to the existing per-user profile event.
- **Server** — Add the default theme to native configuration, persist the selected theme in `UserProfiles`, expose catalog and selection commands, and broadcast catalog changes.
- **Agent Extensions** — Extend the global Pimote extension host with theme-file registration. Keep its existing discovery, reload, ordering, failure isolation, and diagnostics behavior.
- **SDK** — Add the theme-file registration to `@pimote/sdk/pimote` and document the packaged JSON format for extension authors.
- **Web Client** — Add the Appearance tab, theme state, preview/save flow, runtime palette application, theme-aware code surfaces, and early theme bootstrap.
- **Development Tooling** — Add `docs/shipped/themes.md` for all session agents, `packages/sdk/docs/themes.md` for extension authors, and a registration cross-reference in `packages/sdk/docs/authoring.md`. List both theme guides in `server/src/pimote-docs/index.ts` so every session can read them. Update `docs/shipped/static-reports.md` to mention the optional report helper.

Android receives no theme feature or theme catalog payload. Its existing protocol mirror permits additive fields and skips unknown event types.

### New Modules

- **ThemeCatalog** in the Server owns built-in, extension, and user theme definitions. It validates files, resolves palette references and inheritance, applies source precedence, watches the user catalog, retains the last valid catalog after invalid edits, and publishes revisions.
- **ThemeStore** in the Web Client owns the received catalog, current profile selection, local preview, save, cancel, per-user cache, and palette application.
- **Static report theme bridge** at a stable PWA asset path reads the cached resolved theme from local storage, applies its CSS variables, and listens for storage changes. Static-host continues to serve report bundles unchanged.

### Interfaces

#### Theme files and sources

Use one versioned JSON shape for user and extension theme files. Literal colors are CSS color strings. Built-in colors must come from official theme repositories or IDE assets, with source and license provenance recorded alongside the palette data. Do not reconstruct palettes from memory.

```ts
interface ThemeFile {
  version: 1;
  themes: ThemeDefinition[];
}

interface ThemeDefinition {
  id: string;
  name: string;
  colorScheme: 'light' | 'dark';
  extends?: string;
  palette?: Record<string, string>;
  ui: Partial<Record<UiColorToken, ThemeColorValue>>;
  editor: {
    surface: Partial<Record<EditorSurfaceRole, ThemeColorValue>>;
    syntax: Partial<Record<EditorSyntaxRole, ThemeColorValue>>;
    terminal: Partial<Record<AnsiColorName, ThemeColorValue>>;
  };
}

type ThemeColorValue = string | { palette: string };
```

A standalone theme must define every required UI, editor-surface, syntax, and terminal role. A theme that extends another may override selected values. An `extends` reference can name any available theme, with cycle detection. A theme's optional palette defines reusable named colors for its UI, editor, and terminal slots. Validate file structure, IDs, references, and color syntax. Do not enforce contrast.

`UiColorToken` is the stable UI design-token contract. It contains `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `warning`, `warning-foreground`, `border`, `input`, and `ring`; `chart-1` through `chart-5`; `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, and `sidebar-ring`; `status-active`, `status-streaming`, `status-connected`, `status-error`, and `status-reconnecting`; `surface-sunken`, `surface-raised`, `surface-subtle`, and `surface-hover`; `error-accent`, `error-surface`, `error-foreground`, `error-avatar-fg`, `skill-accent`, `skill-surface`, `skill-foreground`, `skill-foreground-hover`, `bash-accent`, `custom-accent`, `custom-surface`, `custom-foreground`, and `custom-foreground-hover`; `link`, `link-hover`, `avatar-bg`, `avatar-fg`, and `shadow-color`. These preserve the color-valued design tokens in `layout.css`. Fonts and radii stay outside the color theme.

`EditorSurfaceRole` is `background`, `foreground`, `selection`, `cursor`, `active-line`, `gutter-background`, `gutter-foreground`, `line-number`, `active-line-number`, `matching-bracket`, and `search-match`. `EditorSyntaxRole` is `comment`, `doc-comment`, `name`, `variable`, `parameter`, `type`, `tag`, `property`, `attribute`, `class`, `label`, `namespace`, `macro`, `constant`, `function`, `built-in`, `keyword`, `control-keyword`, `definition-keyword`, `modifier`, `operator-keyword`, `operator`, `punctuation`, `separator`, `bracket`, `string`, `doc-string`, `character`, `attribute-value`, `number`, `boolean`, `null`, `regexp`, `escape`, `color`, `url`, `content`, `heading`, `content-separator`, `list`, `quote`, `emphasis`, `strong`, `link`, `monospace`, `strikethrough`, `inserted`, `deleted`, `changed`, `invalid`, `meta`, `document-meta`, `annotation`, and `processing-instruction`. These are Pimote roles, not renderer names. CodeMirror and Highlight.js categories map to them. Broad roles supply fallback colors when a renderer lacks a refinement. `AnsiColorName` is the standard eight-color ANSI palette plus its eight bright colors. Extended 256-color ANSI codes keep their existing mapping.

The extension context adds `themes.registerFile(path)`. It resolves relative paths from the registering entry, like `settings.registerFile`, and contributes JSON files to the extension registry. Pimote does not scan another directory. User themes live at `$XDG_CONFIG_HOME/pimote/themes.json`, defaulting to `~/.config/pimote/themes.json`; this file does not appear as a Global Settings editor tab. Extension and user files use the same versioned JSON schema.

Theme IDs are global and stable. The eight built-in IDs are `pimote/light`, `pimote/dark`, `dracula/dracula`, `tokyo-night/tokyo-night`, `nord/nord`, `gruvbox/dark`, `solarized/light`, and `catppuccin/mocha`. Load built-ins first. If an extension or user theme reuses a reserved built-in ID, drop that definition. For other duplicate IDs, retain the first valid definition in deterministic source order and reject later definitions. Extension authors use stable IDs such as `publisher/theme-name`.

The catalog source order is built-ins, extension files in the host's deterministic discovery order, then the user file. A malformed or invalid user file leaves its last valid contribution active. Invalid extension files do not block other extensions or built-ins. The catalog logs diagnostics for invalid entries. Its revision changes when the user file, extension registry, or `defaultTheme` changes. Low contrast is never a loading error and does not produce a warning.

#### Catalog, default, and user preference

The PWA requests the full catalog instead of receiving it in `server_capabilities`. This keeps theme data off Android connections. Theme changes send a small `theme_catalog_changed` event with a revision; the PWA requests a fresh snapshot.

```ts
interface ThemeCatalogSnapshot {
  revision: number;
  defaultThemeId: string;
  themes: ResolvedTheme[];
  diagnostics: ThemeDiagnostic[];
}
```

`ResolvedTheme` contains its stable ID, display name, source kind, color scheme, complete UI tokens, editor surfaces, syntax roles, and terminal colors.

Add `defaultTheme` to native Pimote config, defaulting to `pimote/light`. Treat it as a live field in `ConfigRuntime`. A user profile's `selectedThemeId` is either a theme ID or `null`; `null` means follow the server default. Changing the server default affects profiles that follow the default, not saved overrides.

Add `get_theme_catalog` and `set_theme` WebSocket commands. The catalog response returns the snapshot above. `set_theme` accepts a theme ID or `null`, validates non-null IDs against the current catalog, and updates the user's profile. `user_sessions_changed` carries `selectedThemeId`, so every connection of that user reconciles theme selection through the existing profile path from DR-088. The save control stays disabled until the initial profile reconciliation and session adoption finish. No migration flag is needed.

If a saved user theme is missing, including one whose `extends` base disappeared, render the configured server default and keep the saved ID. If `defaultTheme` is missing, render `pimote/light`. This keeps Pimote usable when an extension or theme file disappears.

#### PWA application and report helper

ThemeStore resolves the selected theme against the catalog, applies a local preview, saves it through `set_theme`, and restores the last saved theme on Cancel. The Appearance tab shows `Follow server default` and built-in, extension, and user themes. Theme cards preview both UI and code palettes. Save applies the choice to all devices using the same Pimote username.

Cache the resolved active theme under a user-scoped local-storage key. A small early bootstrap applies a matching cached theme before the PWA renders, then server state replaces that cache when it arrives. ThemeStore writes `--pimote-ui-*`, `--pimote-editor-*`, and `--pimote-terminal-*` custom properties. `layout.css` maps its Tailwind and component variables to these same slots, which the static-report helper also applies. Theme application sets the root `dark` class and `color-scheme`, and updates browser theme-color metadata. The manifest color remains the installation fallback. Component colors must use theme tokens rather than fixed palette utilities.

CodeMirror tags and Highlight.js classes map to the same Pimote syntax roles. CodeMirror's theme compartment updates surface colors and light/dark mode on preview and save. Highlight.js CSS reads the corresponding custom properties. `ansi-to-html` maps its 16 standard colors to the theme's terminal slots; its extended 256-color output remains standard.

Static reports can load the shared same-origin helper from `/pwa/theme-bridge.js`. It reads the current user's cached resolved theme, applies `--pimote-ui-*`, `--pimote-editor-*`, and `--pimote-terminal-*` variables, and updates on cross-tab storage events. If no cached theme exists, the helper does not override the report's own fallback styles. The report guide presents the helper as the preferred default for general reports, not as a requirement; user-directed styles take precedence. The helper does not rewrite HTML or alter the static-host route.

### Interaction Mocks

- `docs/mocks/client-themes/index.html` — Appearance tab on desktop and mobile; paired theme previews; server-default choice; local preview; Save to sync; Cancel to revert.
