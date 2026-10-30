# Global settings

## Idea

Replace the small home-page button that opens `~/.pi/agent/AGENTS.md` with a first-class Settings experience. The experience will grow from a tabbed collection of files into a mix of file tabs and structured settings.

## Key decisions

- The entry point is a gear on the home page only. On desktop it moves to the bottom-left and becomes larger. On mobile it moves to the top-left.
- The UI calls the experience **Settings**. Code calls the concept **Global settings**. **Session details** remains the user-facing name for per-session controls; `SessionSettings...` remains the precise internal protocol vocabulary.
- Each settings file gets one tab. The initial editor is a generic raw text editor for every file, including JSON. Structured controls can replace individual tabs later.
- The initial well-known files are the user-level Agent instructions file (`~/.pi/agent/AGENTS.md`), Pi's user settings (`~/.pi/agent/settings.json`), and Pimote's native config (`~/.config/pimote/config.json`). The full Pimote config is shown for now, including secret values such as the VAPID private key.
- Pimote configuration gains a `settingsFiles` string array. The SDK gains a global extension hook that contributes additional settings-file paths.
- Extension contributions must be discoverable at server startup. The home dialog cannot depend on a live folder session.
- A declared but missing file remains an empty tab and can be created by saving it.
- Tab labels use the basename. When labels collide, prepend preceding path segments until each label is unique.
- Each tab keeps its own draft and dirty state. Saving is per file. Closing prompts once when any tab has unsaved changes.
- The file manifest is a snapshot for one dialog opening. Changes to Pimote's `settingsFiles` list take effect the next time Settings opens.

## Direction

Build a global settings manifest from built-in, configured, and extension-contributed file paths. Open it from the home-page gear in a tabbed dialog. Reuse the existing file read/write behavior where it fits, but give the multi-file experience independent tab state and clear missing-file handling. Keep the manifest seam separate from future structured setting renderers.

## Open questions

### Sharp questions

- What server and SDK lifecycle loads extension settings-file contributions at startup, and how does it report invalid extensions?
- What is the wire shape for fetching the manifest, reading tab contents, and saving files? Can the existing file commands serve the tab contents without widening arbitrary-file access?
- How are configured and contributed paths expanded, canonicalized, deduplicated, and checked for directories, non-UTF-8 files, symlinks, and unsafe targets?
- What ordering and precedence apply when built-in, configured, and extension sources name the same file?
- How will a future structured tab declare its renderer and validation without changing the file manifest contract?

### Fog

- Whether the Settings dialog eventually needs search, grouping, or source badges for a larger manifest.
- Whether external edits need conflict detection beyond the current last-write-wins file editor.
- Whether secret-aware structured renderers should replace the raw Pimote config tab later.
