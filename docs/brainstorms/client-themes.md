# Web themes

## The idea

Add a full theme feature for the Pimote PWA. Users select a named theme that defines both Pimote UI colors and code-editor colors. Those palettes can differ. Android remains out of scope.

## Decisions

- **A theme is a paired preset.** Selecting one applies both its UI and editor palettes. The palettes remain separately defined because a design family can use different colors for application chrome and source code.
- **Pimote owns the UI vocabulary.** UI colors use semantic design tokens for Pimote roles. Editor colors use a rich, language-neutral set of common syntax roles. Keep the standard 16 ANSI color slots in a separate terminal palette; named swatches can supply their values. Keep extended 256-color ANSI values standard. Do not add language-specific overrides or a specialized per-language model.
- **Ship eight familiar presets.** Include Pimote Light, Pimote Dark, Dracula, Tokyo Night, Nord, Gruvbox Dark, Solarized Light, and Catppuccin Mocha. Source preset colors from official theme repositories or IDE assets during implementation; do not reconstruct them from memory.
- **Use existing extension discovery.** Extension themes arrive as JSON files registered with `context.themes.registerFile(path)`, resolved relative to the extension entry. Do not scan a separate theme directory. Theme IDs are globally unique. Pimote's built-in IDs are reserved and take precedence; drop extension or user definitions that reuse them. Reject other duplicate IDs rather than shadowing. Extension themes are read-only in Pimote; users can create a custom theme that extends an extension theme.
- **Resolve all sources in a separate catalog.** A server `ThemeCatalog` combines built-ins, registered extension files, and the host user's custom theme file. Watch the custom file, retain the last valid catalog after invalid edits, and notify connected clients when valid themes change. Serve the catalog through a PWA-specific request and change notification, not the shared server-capabilities payload.
- **Keep user themes in a host-side catalog.** Use a JSON file at the Pimote user's configuration level, proposed beside `config.json`. A custom theme can extend a built-in or extension-provided theme and override selected values, or stand alone with all required tokens. Optional named palette swatches can be reused across UI and editor tokens. Do not require users to copy a complete theme.
- **Let sessions author themes.** Do not build a visual theme editor or expose the raw theme file as an editable Settings tab. A user can ask any session to create or change the custom theme file. Shipped Pimote documentation must explain the format well enough for an agent to complete the task without extra guidance.
- **Preview before saving.** The Appearance tab previews a selected full theme on the current device. Save makes it the Pimote user's shared selection; Cancel restores the saved theme. A Follow server default choice clears the user's override. Theme saving waits until the initial user profile reconcile and session adoption complete, so the existing freshness contract needs no extra migration flag.
- **Share the active choice by Pimote user.** A user's selected theme follows that Pimote username across devices. Pimote usernames are honor-system identities, not authentication. This setting controls appearance only.
- **Set a server default for new users.** Add a native server setting that names the theme for a Pimote user with no saved choice. Changing the default does not replace existing users' selections. An unavailable saved theme uses the configured server default; an unavailable server default falls back to Pimote Light. Keep unavailable saved IDs unchanged.
- **Do not enforce contrast checks.** Accept syntactically valid theme colors without warnings or contrast-based rejection. Keep schema and parse errors separate from color contrast.
- **Support themed static reports without changing the host contract.** Keep static-host bundles verbatim. Provide one lightweight same-origin helper script that reads the PWA's cached resolved theme from local storage and updates on cross-tab storage changes. The shipped report guide recommends it for general reports but does not require it or override a requested custom style.

## Direction

Add an Appearance tab to the PWA Settings experience. Preview the eight built-in presets and any extension or custom themes. Save the selected full theme per Pimote user, or follow the native server `defaultTheme` when no override is saved. Include shipped theme-authoring documentation for all sessions. Preserve the current default appearance as the initial server default unless the product chooses another value. Provide an optional shared helper for static reports; keep custom report styles under the author's control.

The existing extension host loads modules from `$XDG_CONFIG_HOME/pimote/extensions` and user-scope Pi packages' `pimote.extensions` entries. The host currently exposes folder-source and Settings-file registration only. Architecture must define a theme-contribution seam that follows this lifecycle and its failure isolation.

## Open questions for architecture

- Define the user theme-file schema, UI token names, editor-role names, swatch-reference syntax, validation, and behavior when a referenced theme disappears.
- Map the agreed language-neutral editor roles across CodeMirror, Highlight.js, and the ANSI palette.
- Apply a selection without a flash on startup, and decide how browser chrome and installed-PWA colors respond.
- Define the shared static-report helper's public CSS variables and fallback when no cached theme snapshot exists.
