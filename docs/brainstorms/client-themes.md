# Web themes

## The idea

Add a full theme feature for the Pimote PWA. Users select a named theme that defines both Pimote UI colors and code-editor colors. Those palettes can differ. Android remains out of scope.

## Decisions

- **A theme is a paired preset.** Selecting one applies both its UI and editor palettes. The palettes remain separately defined because a design family can use different colors for application chrome and source code.
- **Pimote owns the UI vocabulary.** UI colors use semantic design tokens for Pimote roles. Editor colors use a rich, language-neutral set of common syntax roles. Do not add language-specific overrides or a specialized per-language model.
- **Ship a balanced preset set.** Include about eight familiar light and dark themes, such as Dracula, Tokyo Night, Nord, Gruvbox, Solarized, GitHub, and Catppuccin. Preserve the current Pimote dark and light palettes as choices. The exact set can be proposed during architecture.
- **Use existing extension discovery.** Extension themes must arrive through the Pimote extension host's normal loading mechanism. Do not scan a separate theme directory. Extension themes are read-only in Pimote; users can create a custom theme that extends an extension theme.
- **Keep user themes in a host-side catalog.** Use a JSON file at the Pimote user's configuration level, proposed beside `config.json`. A custom theme can extend a built-in or extension-provided theme and override selected values. Optional named palette swatches can be reused across UI and editor tokens. Do not require users to copy a complete theme.
- **Let sessions author themes.** Do not build a visual theme editor or expose the raw theme file as an editable Settings tab. A user can ask any session to create or change the custom theme file. Shipped Pimote documentation must explain the format well enough for an agent to complete the task without extra guidance.
- **Share the active choice by Pimote user.** A user's selected theme follows that Pimote username across devices. Pimote usernames are honor-system identities, not authentication. This setting controls appearance only.
- **Set a server default for new users.** Add a native server setting that names the theme for a Pimote user with no saved choice. Changing the default does not replace existing users' selections.
- **Do not enforce contrast checks.** Accept syntactically valid theme colors without warnings or contrast-based rejection. Keep schema and parse errors separate from color contrast.

## Direction

Add a theme picker to the PWA Settings experience. Bundle Pimote's built-in presets, collect extension-provided themes through the current extension system, and load user-defined themes from the host-side JSON catalog. Store the selected full theme per Pimote user. Add a native server `defaultTheme` setting for users without a saved choice. Include shipped theme-authoring documentation for all sessions. Preserve the current default appearance as the initial server default unless the product chooses another value.

The existing extension host loads modules from `$XDG_CONFIG_HOME/pimote/extensions` and user-scope Pi packages' `pimote.extensions` entries. The host currently exposes folder-source and Settings-file registration only. Architecture must define a theme-contribution seam that follows this lifecycle and its failure isolation.

## Open questions for architecture

- Define the extension registration contract, stable theme IDs, duplicate handling, reload behavior, and whether an extension contributes a theme object or a packaged data file.
- Define the custom theme schema, host file path, inheritance rules, swatch references, validation, and behavior when a referenced theme disappears.
- Define how `defaultTheme` resolves against themes registered by extensions and how Pimote falls back if that theme is unavailable.
- Select the rich common editor-role vocabulary and map it across CodeMirror and Highlight.js without language-specific roles.
- Choose persistence and delivery for the active theme by Pimote user, including first-run selection and devices that reconnect with stale data.
- Apply a selection without a flash on startup, and decide how browser chrome and installed-PWA colors respond.
- Ensure the shipped theme guide is discoverable by any session that can edit the user theme file.
