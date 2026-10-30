# Global settings

## Idea

Replace the small home-page button that opens `~/.pi/agent/AGENTS.md` with a first-class Settings experience. The experience will grow from a tabbed collection of files into a mix of file tabs and structured settings.

## Key decisions

- The entry point is a gear on the home page only. On desktop it moves to the bottom-left and becomes larger. On mobile it moves to the top-left.
- The UI calls the experience **Settings**. Code calls the concept **Global settings**. **Session details** remains the user-facing name for per-session controls; `SessionSettings...` remains the precise internal protocol vocabulary.
- Each settings file gets one tab. The initial editor is a generic raw text editor for every file, including JSON. Structured controls can replace individual tabs later.
- The initial well-known files are the user-level Agent instructions file (`<effective-agent-dir>/AGENTS.md`), Pi's user settings (`<effective-agent-dir>/settings.json`), and Pimote's native config (`<effective-pimote-config-path>`). The full Pimote config is shown for now, including secret values such as the VAPID private key. The server resolves these paths through Pi's effective agent directory and Pimote's XDG config path; the client must not hard-code them.
- Pimote configuration gains a `settingsFiles` string array. It does not gain an extension list or extension-directory override. Pimote extensions gain a settings-file registration hook that contributes additional paths.
- Pure Pimote extensions are trusted modules loaded from the user-level `$XDG_CONFIG_HOME/pimote/extensions/` directory. Pimote also resolves user-level Pi-installed packages and loads only their `pimote.extensions` entries. Pimote mirrors Pi's smart module discovery but has no local/project extension scope. Factories run at startup and on the server-wide `/reload`; they provide server-global contributions and do not receive Pi's `ExtensionAPI`.
- Pi extensions remain Pi-hosted, session-scoped modules. Their Pimote SDK interactions continue through session bridges such as the panels EventBus. A package can declare separate `pi.extensions` and `pimote.extensions` entries; each host loads only its own entries. Pi-only extensions do not contribute Global settings files.
- Existing client code that hard-codes Pi or Pimote config paths, including the tag-snippet loader, is updated to use the server-resolved effective paths. Pi paths use the effective agent directory; Pimote config paths use the effective XDG config path.
- Installing a Pi package with a `pimote.extensions` manifest entry implicitly enables its Pimote contribution. Pimote resolves only user-level Pi packages, never project-local packages.
- The finished feature must document the Pimote/Pi extension-host split, package manifest entries, discovery scopes, reload boundaries, SDK surfaces, removed FolderCreator seam, effective paths, and the ownership boundary for Pi-native and third-party settings files. Update the SDK README, Pimote configuration documentation, package examples, and injected `pimote-docs` guidance.
- Pimote extension modules export one default factory. The Pimote host context registers `FolderSource` and settings-file contributions, and exposes a shutdown lifecycle event for `/reload`. `FolderCreator` is removed from the public SDK; built-in folder creation remains Pimote core.
- Pimote extension reload follows Pi's lifecycle: await shutdown handlers, invalidate the old runtime, clear the module cache, load a fresh registry, and replace the old registry even when individual modules fail. Concurrent reloads are serialized.
- Reload logic applies only to Pimote's native configuration file. Safe Pimote configuration fields can reload dynamically; unsafe lifecycle fields remain startup-only until their consumers support live replacement. Pi-native and third-party settings files are read and written without Pimote-specific reload behavior. Config-listed settings paths resolve relative to Pimote's config directory. Extension-contributed relative paths resolve relative to their module.
- A declared but missing file remains an empty tab and can be created by saving it.
- Tab labels use the basename. When labels collide, prepend preceding path segments until each label is unique.
- Each tab keeps its own draft and dirty state. Saving is per file. Closing prompts once when any tab has unsaved changes.
- The tag-wrap toolbar is available only for Markdown files. Tag snippets are generic UI data; the Pimote config tab is not a special editor tab.
- The file manifest is a snapshot for one dialog opening. Changes to Pimote's `settingsFiles` list take effect the next time Settings opens.

## Direction

Build a global settings manifest from built-in, configured, and extension-contributed file paths. Open it from the home-page gear in a tabbed dialog. Reuse the existing file read/write behavior where it fits, but give the multi-file experience independent tab state and clear missing-file handling. Keep the manifest seam separate from future structured setting renderers.

## Open questions

### Sharp questions

- What Pimote-extension loader and SDK factory context collects settings-file contributions at startup, and how does it report invalid extensions?
- What is the wire shape for fetching the manifest, reading tab contents, and saving files? Can the existing file commands serve the tab contents without widening arbitrary-file access?
- How are configured and contributed paths expanded, canonicalized, deduplicated, and checked for directories, non-UTF-8 files, symlinks, and unsafe targets?
- What ordering and precedence apply when built-in, configured, and extension sources name the same file?
- How will a future structured tab declare its renderer and validation without changing the file manifest contract?

### Fog

- Whether the Settings dialog eventually needs search, grouping, or source badges for a larger manifest.
- Whether external edits need conflict detection beyond the current last-write-wins file editor.
- Whether secret-aware structured renderers should replace the raw Pimote config tab later.
