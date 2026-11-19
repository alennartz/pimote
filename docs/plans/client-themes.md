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

A standalone theme must define every required UI, editor-surface, syntax, and terminal role. A theme that extends another may override selected values. An `extends` reference can name any available theme, with cycle detection. A theme's optional palette defines reusable named colors for its UI, editor, and terminal slots. Child themes inherit parent swatches and can override them. Validate file structure, IDs, references, and CSS Color 4 syntax. Use `colorjs.io` for server-side color parsing and retain the original color strings. Do not enforce contrast.

`UiColorToken` is the stable UI design-token contract. It contains `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `warning`, `warning-foreground`, `border`, `input`, and `ring`; `chart-1` through `chart-5`; `sidebar`, `sidebar-foreground`, `sidebar-primary`, `sidebar-primary-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, and `sidebar-ring`; `status-active`, `status-streaming`, `status-connected`, `status-error`, and `status-reconnecting`; `surface-sunken`, `surface-raised`, `surface-subtle`, and `surface-hover`; `error-accent`, `error-surface`, `error-foreground`, `error-avatar-fg`, `skill-accent`, `skill-surface`, `skill-foreground`, `skill-foreground-hover`, `bash-accent`, `custom-accent`, `custom-surface`, `custom-foreground`, and `custom-foreground-hover`; `link`, `link-hover`, `avatar-bg`, `avatar-fg`, and `shadow-color`. These preserve the color-valued design tokens in `layout.css`. Fonts and radii stay outside the color theme.

`EditorSurfaceRole` is `background`, `foreground`, `selection`, `cursor`, `active-line`, `gutter-background`, `gutter-foreground`, `line-number`, `active-line-number`, `matching-bracket`, and `search-match`. `EditorSyntaxRole` is `comment`, `doc-comment`, `name`, `variable`, `parameter`, `type`, `tag`, `property`, `attribute`, `class`, `label`, `namespace`, `macro`, `constant`, `function`, `built-in`, `keyword`, `control-keyword`, `definition-keyword`, `modifier`, `operator-keyword`, `operator`, `punctuation`, `separator`, `bracket`, `string`, `doc-string`, `character`, `attribute-value`, `number`, `boolean`, `null`, `regexp`, `escape`, `color`, `url`, `content`, `heading`, `content-separator`, `list`, `quote`, `emphasis`, `strong`, `link`, `monospace`, `strikethrough`, `inserted`, `deleted`, `changed`, `invalid`, `meta`, `document-meta`, `annotation`, and `processing-instruction`. These are Pimote roles, not renderer names. CodeMirror and Highlight.js categories map to them. Broad roles supply fallback colors when a renderer lacks a refinement. `AnsiColorName` is the standard eight-color ANSI palette plus its eight bright colors. Extended 256-color ANSI codes keep their existing mapping.

The extension context adds `themes.registerFile(path)`. It resolves relative paths from the registering entry, like `settings.registerFile`, and contributes JSON files to the extension registry. Pimote does not scan another directory. User themes live at `$XDG_CONFIG_HOME/pimote/themes.json`, defaulting to `~/.config/pimote/themes.json`; this file does not appear as a Global Settings editor tab. Extension and user files use the same versioned JSON schema.

Theme IDs are global and stable. The eight built-in IDs are `pimote/light`, `pimote/dark`, `dracula/dracula`, `tokyo-night/tokyo-night`, `nord/nord`, `gruvbox/dark`, `solarized/light`, and `catppuccin/mocha`. Load built-ins first. If an extension or user theme reuses a reserved built-in ID, drop that definition. For other duplicate IDs, retain the first valid definition in deterministic source order and reject later definitions. Extension authors use stable IDs such as `publisher/theme-name`.

The catalog source order is built-ins, extension files in the host's deterministic discovery order, then the user file. A malformed or invalid user file leaves its last valid contribution active. Invalid extension files do not block other extensions or built-ins. The catalog logs diagnostics for invalid entries. Its revision changes when the user file, extension registry, or `defaultTheme` changes. Low contrast is never a loading error and does not produce a warning. The catalog reader exposes a watch subscription so tests can deliver file changes without timing assumptions.

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

ThemeStore resolves the selected theme against the catalog, applies a local preview, saves it through `set_theme`, and restores the last saved theme on Cancel. Closing mobile Settings also cancels an unsaved preview. The Appearance tab shows `Follow server default` and built-in, extension, and user themes. Theme cards preview both UI and code palettes. Save applies the choice to all devices using the same Pimote username.

Cache the resolved active theme under a user-scoped local-storage key. A small early bootstrap applies a matching cached theme before the PWA renders, then server state replaces that cache when it arrives. ThemeStore writes `--pimote-ui-*`, `--pimote-editor-*`, and `--pimote-terminal-*` custom properties. `layout.css` maps its Tailwind and component variables to these same slots, which the static-report helper also applies. Theme application sets the root `dark` class and `color-scheme`, and updates browser theme-color metadata. The manifest color remains the installation fallback. Component colors must use theme tokens rather than fixed palette utilities.

CodeMirror tags and Highlight.js classes map to the same Pimote syntax roles. `createCodeMirrorTheme(theme)` supplies an extension for a reconfigurable compartment, which updates surface colors and light/dark mode on preview and save. Highlight.js CSS reads the corresponding custom properties. `ansi-to-html` maps its 16 standard colors to the theme's terminal slots; its extended 256-color output remains standard.

Static reports can load the shared same-origin helper from `/pwa/theme-bridge.js`. Its `startReportThemeBridge()` entry reads the current user from `pimote:user`, applies that user's cached `--pimote-ui-*`, `--pimote-editor-*`, and `--pimote-terminal-*` variables, and updates on cross-tab storage events, including user changes. If no cached theme exists, the helper does not override the report's own fallback styles. The report guide presents the helper as the preferred default for general reports, not as a requirement; user-directed styles take precedence. The helper does not rewrite HTML or alter the static-host route.

### Interaction Mocks

- `docs/mocks/client-themes/index.html` — Appearance tab on desktop and mobile; paired theme previews; server-default choice; local preview; Save to sync; Cancel to revert.

## Tests

**Pre-test-write commit:** `669b46af250a96903d5d6ba5b929ff95aeb6ee79`

### Interface Files

- `shared/src/themes.ts` — Versioned theme-file, token, resolved-theme, diagnostic, and catalog snapshot types.
- `shared/src/index.ts` — Shared theme type exports.
- `shared/src/protocol.ts` — Theme catalog request, selection command, catalog-change event, and user-profile selection fields.
- `server/src/config.ts` — Native `defaultTheme` configuration field.
- `server/src/theme-catalog.ts` — Server catalog lifecycle, built-in definitions, source reader and watcher, snapshot, revision, and listener boundary.
- `server/src/server.ts` — WebSocket transport and catalog subscription boundary.
- `server/src/theme-preferences.ts` — Server catalog and per-user selection command boundary.
- `server/src/user-profiles.ts` — Persisted theme selection interface on user profiles.
- `server/src/pimote-extensions/types.ts` — Extension theme-file registration in the host registry.
- `server/src/pimote-extensions/index.ts` — Extension context theme-registration seam.
- `packages/sdk/src/pimote/index.ts` — `context.themes.registerFile` SDK contract.
- `client/src/lib/stores/theme-store.svelte.ts` — PWA catalog, profile reconciliation, preview, save, cancel, and cache boundary.
- `client/src/lib/theme-application.ts` — Root palette, mode, and browser metadata application boundary.
- `client/src/lib/theme-bootstrap.ts` — Early cached-theme bootstrap boundary.
- `client/src/lib/theme-bridge.ts` — Static-report cache bridge entry, lifecycle, and cache-key boundary.
- `client/src/lib/codemirror-theme.ts` — Reconfigurable CodeMirror theme extension.
- `client/src/lib/components/AppearanceSettings.svelte` — Appearance tab component surface.

### Test Files

- `server/src/theme-catalog.test.ts` — Source precedence, validation, inheritance, palette resolution, diagnostics, retention, and revisions.
- `server/src/pimote-extensions/themes.test.ts` — Extension theme-file path resolution, ordering, isolation, and reload invalidation.
- `server/src/user-profiles-themes.test.ts` — Per-user theme override persistence, clearing, isolation, and document compatibility.
- `server/src/config-themes.test.ts` — Native default parsing and live runtime updates.
- `server/src/theme-preferences.test.ts` — Catalog reads, valid and null selection, invalid IDs, and unavailable-theme fallbacks.
- `server/src/ws-themes.test.ts` — Catalog transport, revision notifications, and per-user propagation.
- `server/src/pimote-docs/index.test.ts` — Theme guide registration.
- `server/src/static-host/http-handler.test.ts` — Verbatim report serving.
- `client/src/lib/stores/theme-store.svelte.test.ts` — PWA catalog refresh, profile adoption, local preview, save gating, cancel, and default selection.
- `client/src/lib/theme-application.test.ts` — CSS custom properties, root mode, color-scheme, browser metadata, and manifest fallback behavior.
- `client/src/lib/theme-bootstrap.test.ts` — Early user-scoped cache application and invalid-cache fallback.
- `client/src/lib/theme-bridge.test.ts` — User-scoped cache, no-cache fallback, and cross-tab lifecycle.
- `client/src/lib/theme-report-entry.test.ts` — Report entry user discovery and storage updates.
- `client/src/lib/theme-rendering.test.ts` — CodeMirror, Highlight.js, and ANSI palette rendering.
- `client/src/lib/components/AppearanceSettings.test.ts` — Appearance choices, preview, Save, Cancel, and mobile Close.
- `shared/test/theme-fixtures.ts` — Complete test palettes for server and client boundaries.

### Behaviors Covered

#### Theme catalog

- All eight built-ins have complete palettes, and built-in, extension, and user files resolve in deterministic source order.
- Malformed files isolate their diagnostics and do not block valid sources.
- Reserved built-in IDs and later duplicate IDs do not shadow the first valid definition.
- Palette references and inheritance resolve into complete paired UI, editor, and terminal tokens; children inherit and can override swatches.
- Invalid structure, missing roles, invalid colors, and missing swatches are rejected; low-contrast colors load without warnings.
- Cycles and missing inheritance bases reject only the affected themes.
- Invalid user edits retain the last valid user contribution.
- Valid watched user-file changes and native default changes publish incremented revisions.

#### Extension registration

- `context.themes.registerFile` resolves relative and home-relative paths from the entry.
- Registrations retain deterministic discovery order and isolate failing entries.
- Reload invalidates old theme registrations.

#### Profiles and server commands

- A profile starts with no override, persists one user's override, and clears it with `null`.
- A theme override never changes another user's profile.
- Native configuration defaults to `pimote/light`, accepts a configured ID, and applies live updates.
- Catalog requests return the PWA snapshot, valid IDs save, `null` follows the server default, and unknown IDs fail.
- Missing saved themes, including themes with a missing parent, use the configured default while retaining the saved ID; an unavailable default uses `pimote/light`.
- A default change affects followers without replacing saved overrides.
- WebSocket catalog requests and revision notifications carry theme data only on the PWA-specific path; selection propagates to same-user connections but not other users.

#### PWA ThemeStore and Appearance

- The PWA requests a full catalog and refreshes after a revision-only event.
- Profile reconciliation adopts the shared selection before Save becomes available.
- Theme selection previews paired UI and code palettes locally; Cancel restores the saved selection.
- Save remains disabled until profile reconciliation and session adoption finish, then sends `set_theme` for a theme or `null`.
- Appearance shows Follow server default and built-in, extension, and user choices. Mobile Close cancels a preview.

#### Palette application and static reports

- Theme application writes UI, editor, and terminal custom properties and updates root mode and browser theme metadata.
- CodeMirror and Highlight.js render common syntax roles from the active palette; ANSI standard slots follow the theme and indexed colors retain their standard mapping.
- The PWA applies a valid user-scoped cached theme before its first render and leaves fallback styles untouched for invalid or absent cache data.
- Static reports discover the current user, use the user-scoped cached resolved theme, leave fallback styles untouched without a cache, and react to cross-tab updates until stopped.
- Static-host serves report bundles verbatim, and the session documentation lists both theme guides.

**Review status:** approved

## Steps

**Pre-implementation commit:** `9c322b98e397525cdc66fefcdf35224d48855e93`

### Step 1: Install the color parser

Use npm to add `colorjs.io` as a runtime dependency of both `@pimote/server` and the published root package. The packaged server runs from the root package, not the workspace manifest. Use the parser to validate CSS Color 4 literals without converting them or checking contrast.

**Verify:** `npm ls colorjs.io` lists the dependency, and both runtime manifests include it.
**Status:** done

### Step 2: Ship the built-in palettes

Create `server/src/builtin-themes.ts` and implement `builtinThemeDefinitions()` in `server/src/theme-catalog.ts`. Supply the eight IDs from the architecture, with every role from `shared/src/themes.ts`. Use the existing Pimote UI assets and official theme repositories or IDE assets for colors. Record source URLs and licenses alongside the palette data. Preserve the existing light and dark fallback appearance; do not infer third-party palettes from the mock.

**Verify:** After Step 3, the built-in palette case in `server/src/theme-catalog.test.ts` passes and each palette's provenance is present beside its data.
**Status:** done

### Step 3: Implement catalog resolution

Implement `ThemeCatalog` in `server/src/theme-catalog.ts` using its existing `ThemeCatalogOptions`, `ThemeCatalogReader`, `ThemeCatalogListener`, and snapshot methods. Validate versioned files, theme IDs, role maps, literal colors with `colorjs.io`, palette references, and inheritance. Resolve cross-source parents and inherited swatches, reject cycles and missing bases, and produce complete `ResolvedTheme` values. Enforce reserved IDs and first-valid duplicate precedence in built-in, extension, then user order. Keep invalid sources isolated, retain the last valid user contribution after an invalid edit, and log diagnostics without contrast warnings.

Implement `load`, `reload`, `snapshot`, `onChange`, `setDefaultTheme`, and `close`. Use the reader's watch seam for user-file changes. Add a catalog operation that replaces the extension-file list and reloads it when the host registry changes. Publish incremented revisions for source, registry, and default changes, and stop the watcher on close.

**Verify:** `npm run build:shared` followed by `npm test -w @pimote/server -- --run src/theme-catalog.test.ts` passes.
**Status:** done

### Step 4: Register extension theme files

In `server/src/pimote-extensions/index.ts`, implement `themes.registerFile` using the same path expansion, staged-entry isolation, and runtime invalidation as `settings.registerFile`. Carry theme paths through `Runtime.commit` and `snapshot` in discovery order. Return an empty list before startup and after reload when no files register. Keep `PimoteExtensionRegistry` in `server/src/pimote-extensions/types.ts` and `PimoteExtensionContext` in `packages/sdk/src/pimote/index.ts` consistent with this contract.

**Verify:** `npm test -w @pimote/server -- --run src/pimote-extensions/themes.test.ts src/pimote-extensions/host.test.ts` passes.
**Status:** done

### Step 5: Persist selections and native defaults

In `server/src/config.ts`, parse `defaultTheme` and default it to `pimote/light`. In `server/src/config-runtime.ts`, carry the candidate default into the live snapshot on `apply`. In `server/src/user-profiles.ts`, implement `selectedTheme` and `setSelectedTheme` using the existing serialized persistence path. Load old documents without the field as `null`, preserve sessions and other profile facts, and keep users isolated. A selection must not be saved before the existing session-adoption gate completes.

Implement `ThemePreferences.getCatalog`, `setTheme`, and `resolve` in `server/src/theme-preferences.ts`. Reject unknown non-null IDs, persist valid IDs and `null`, and resolve a missing saved ID through the configured default and then `pimote/light` without erasing the saved ID.

**Verify:** `npm test -w @pimote/server -- --run src/config-themes.test.ts src/user-profiles-themes.test.ts src/theme-preferences.test.ts` passes.
**Status:** done

### Step 6: Wire the server lifecycle and protocol

In `server/src/paths.ts` and `server/src/index.ts`, use `$XDG_CONFIG_HOME/pimote/themes.json` for the user file. Construct and load the catalog from built-ins, the initial extension registry, and the runtime default before accepting connections. Supply a filesystem reader and watcher that notices creation, replacement, and edits of the user file. On extension-host reload, replace catalog registrations. On native config save, apply the new default to the catalog. Close the catalog watcher on shutdown.

In `server/src/server.ts` and `server/src/ws-handler.ts`, use the existing catalog parameter to handle `get_theme_catalog` and `set_theme` through `ThemePreferences`. Add `selectedThemeId` to `WsHandler.userSessionsEvent`; broadcast selection changes to the acting user's connections. Subscribe to catalog changes and send only `theme_catalog_changed` with its revision. Unsubscribe when the server closes. Keep the full catalog out of `server_capabilities` and connect snapshots. Use the command and event types already declared in `shared/src/protocol.ts` and exported by `shared/src/index.ts`.

**Verify:** `npm test -w @pimote/server -- --run src/ws-themes.test.ts src/theme-catalog.test.ts` passes. Catalog changes carry no palette payload until requested.
**Status:** done

### Step 7: Apply and cache resolved palettes

Implement `applyResolvedTheme` in `client/src/lib/theme-application.ts`. Write all `--pimote-ui-*`, `--pimote-editor-*`, and `--pimote-terminal-*` slots, set the root dark class and `color-scheme`, and update the theme-color meta element when present. Leave the manifest unchanged.

In `client/src/lib/theme-bridge.ts`, implement the shared user-scoped `themeCacheKey` and safe cached-theme reading. Implement `bootstrapCachedTheme` in `client/src/lib/theme-bootstrap.ts` so missing, malformed, or incomplete cached data leaves fallback styles untouched. Storage access must tolerate browser storage failures.

In `client/src/routes/layout.css`, map existing UI variables and Tailwind colors to the shared UI slots with light fallback values. Do not let `.dark` overwrite a resolved palette. Keep fonts and radii outside the theme.

**Verify:** `npm test -w client -- --run src/lib/theme-application.test.ts src/lib/theme-bootstrap.test.ts` passes. The manifest theme color remains the installation fallback.
**Status:** done

### Step 8: Build the ThemeStore and connect it

Implement the reactive `ThemeStore` in `client/src/lib/stores/theme-store.svelte.ts` behind its existing interface. Request the catalog, refresh on revision events, reconcile profile selections, resolve missing IDs through the default and Pimote Light, and apply and cache the active resolved palette. Preview stays local; Cancel restores the saved selection. Save sends `set_theme` only after profile reconciliation and session adoption finish. Handle `null` as Follow server default, and retain a missing saved ID.

Wire the store into `client/src/lib/stores/connection.svelte.ts` and `client/src/routes/+layout.svelte`. The connection currently consumes `user_sessions_changed` without emitting it, so deliver that event after its reconciliation plan. Use `connection.ready` after restore completion for the adoption gate. Load the catalog for each connection, reset the gate on disconnect, and refresh on catalog revisions. Follow `userIdentity` changes and reconnects so another user's cache, profile, and in-flight responses cannot become the new user's state.

**Verify:** `npm test -w client -- --run src/lib/stores/theme-store.svelte.test.ts src/lib/stores/user-sessions-reconcile.test.ts` passes. Switching usernames loads that user's profile and theme.
**Status:** done

### Step 9: Bootstrap before rendering

Create a browser entry for `bootstrapCachedTheme` and configure `client/vite.config.ts` to emit a stable, synchronous browser asset. Load it from `client/src/app.html` before the app renders. Discover the current user from `pimote:user`, using the server's `default` identity when no name is stored. Use the same cache key and application code as ThemeStore. Preserve the CSS fallback when storage or cache data is unavailable.

**Verify:** `npm run build -w client` produces the referenced asset in `client/build`. Loading the built PWA with a valid cached dark theme applies it before the first app render; an absent or invalid cache keeps the fallback.
**Status:** done

### Step 10: Theme code and terminal surfaces

Implement `createCodeMirrorTheme(theme)` in `client/src/lib/codemirror-theme.ts`, mapping editor surface roles and Lezer tags to Pimote syntax roles. In `client/src/lib/components/ExtensionCodeEditor.svelte`, replace the fixed GitHub theme with a theme compartment and reconfigure it when the active theme changes, without replacing the editor document or its language compartment.

Replace fixed Highlight.js colors in `client/src/lib/highlight-theme.css` with the matching editor variables and role fallbacks. Update `client/src/lib/ansi-to-html.ts` so standard 16-color foreground and background codes use terminal slots. Preserve the existing 256-color indexed mapping, including indices 0–15, and retain escaping and reset behavior.

**Verify:** `npm test -w client -- --run src/lib/theme-rendering.test.ts src/lib/code-highlight.test.ts` passes, including live editor reconfiguration and all indexed ANSI colors.
**Status:** done

### Step 11: Add the Appearance tab

Implement `client/src/lib/components/AppearanceSettings.svelte` with the existing `store` and `viewport` props. Follow `docs/mocks/client-themes/index.html`: show Follow server default with the current default name, and a selectable card for each built-in, extension, and user theme. Each card previews UI and code colors, identifies its source and light or dark scheme, and marks the server default. Show the selected state and an accessible preview status that distinguishes unsaved local preview from saved selection.

Integrate the pane into `client/src/lib/components/GlobalSettingsDialog.svelte` and its existing `CodeEditorDialog.svelte` shell. Desktop uses Cancel and Save theme; mobile uses Close and Save theme in the header. Do not duplicate the shell's controls. Save obeys the store gate, Cancel restores the saved theme, and every mobile Close path cancels an unsaved preview. Preserve User and file tabs, file drafts, and their discard confirmation.

**Verify:** `npm test -w client -- --run src/lib/components/AppearanceSettings.test.ts src/lib/components/GlobalSettingsDialog.test.ts` passes. Compare the desktop and mobile flows with the approved mock.
**Status:** done

### Step 12: Replace fixed component colors

Audit color-valued styles under `client/src/lib/components/` and `client/src/routes/`, including fixed Tailwind palette utilities and dark-only branches. Map component colors to the existing semantic UI tokens or theme-derived color mixes. Preserve transparent overlays and non-color layout rules. Do not introduce new theme roles or change fonts and radii.

**Verify:** `npm test -w client -- --run src/lib/color-token-guard.test.ts` passes. Preview a light and a dark theme across settings, dashboard, transcript, dialogs, and status surfaces without fixed palette colors overriding the selected theme.
**Status:** done

### Step 13: Publish the report bridge

Implement `ThemeBridge` and `startReportThemeBridge()` in `client/src/lib/theme-bridge.ts`. Apply the current user's cached palette, react to cross-tab cache and `pimote:user` changes, and stop listening when the returned cleanup runs. Without a valid cache, leave the report's fallback styles untouched.

Create a browser entry that starts the bridge and configure `client/vite.config.ts` to emit it at `/pwa/theme-bridge.js`. Keep it same-origin and usable by an ordinary report script tag. Do not rewrite reports or alter `server/src/static-host/http-handler.ts`.

**Verify:** `npm test -w client -- --run src/lib/theme-bridge.test.ts src/lib/theme-report-entry.test.ts` and `npm test -w @pimote/server -- --run src/static-host/http-handler.test.ts` pass. The built asset is served at `/pwa/theme-bridge.js`.
**Status:** done

### Step 14: Ship theme guides and verify the feature

Create `docs/shipped/themes.md` for session agents and `packages/sdk/docs/themes.md` for extension authors. Document the versioned JSON shape, all required roles, palette references, inheritance, IDs, source precedence, validation, user path, default and override behavior, and extension registration. Add the registration cross-reference in `packages/sdk/docs/authoring.md`. Register both guides in `server/src/pimote-docs/index.ts`. Update `docs/shipped/settings.md` for the live native default and `docs/shipped/static-reports.md` for the optional same-origin bridge, its fallback, and user-directed style precedence.

Run the existing theme tests without changing them, then run the project build, checks, and relevant server and client suites. Verify that the published package includes the guides and the runtime parser dependency.

**Verify:** `npm test -w @pimote/server -- --run src/pimote-docs/index.test.ts` passes. `npm run build`, `npm run check`, and `npm run lint` pass; `npm pack --dry-run` includes the built bridge and both guides.
**Status:** not started
