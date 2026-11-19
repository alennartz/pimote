# Review: client-themes

**Plan:** `docs/plans/client-themes.md`  
**Diff range:** `1a64ef6..72dda1d`  
**Date:** 2026-11-19

## Summary

The fix series resolves 13 of the 17 prior findings. Four prior findings remain open or partially resolved: user theme edits still do not reload, Follow server default loses its selected state when the configured default is unavailable, existing ANSI output can keep fixed colors, and unrelated smoke-test work remains in the feature diff. The fixes also introduce three new client issues involving preview cancellation, warning readability, and asynchronous bootstrap ordering.

## Prior Finding Verification

|   # | Prior finding                                                 | Result      | Verification                                                                                                                        |
| --: | ------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
|   1 | User theme edits never reload                                 | **open**    | `server/src/index.ts:116-127` still uses `watchFile`; its callback receives `Stats`, so the basename check cannot match file edits. |
|   2 | Save stays disabled after selecting a preview                 | resolved    | `previewing` is now reactive in `theme-store.svelte.ts`.                                                                            |
|   3 | Unsaved previews enter the shared cache                       | resolved    | Preview application skips cache writes until the selection is saved.                                                                |
|   4 | Report bridges retain the previous user's palette             | resolved    | Both bridges restore captured fallbacks for invalid or absent caches and use the shared validator.                                  |
|   5 | Fixed component colors override themes                        | resolved    | The listed fixed palette classes now use semantic tokens or theme-derived mixes.                                                    |
|   6 | Extension file edits survive reload                           | resolved    | Registered extension paths reload even when their path list is unchanged.                                                           |
|   7 | Third-party palettes leave required roles indistinguishable   | resolved    | Third-party built-ins now provide distinct surface and status roles.                                                                |
|   8 | Closing settings can preserve an unsaved theme                | **partial** | Close and tab-switch cancellation now run through the dialog, but the unavailable-default selection edge remains.                   |
|   9 | Theme save failures become unhandled rejections               | resolved    | Save failures are caught and shown in the dialog.                                                                                   |
|  10 | Bootstrap and report assets duplicate the source modules      | resolved    | Vite now emits stable entries from the shared modules; the static copies are gone.                                                  |
|  11 | Appearance cards do not implement the paired preview          | resolved    | Cards now render paired interface and editor previews.                                                                              |
|  12 | Theme guides omit required role details                       | resolved    | Both guides enumerate the required roles and label abbreviated examples.                                                            |
|  13 | CodeMirror keeps dark mode after switching to light           | resolved    | The layout-only theme no longer sets a fixed dark facet.                                                                            |
|  14 | Existing ANSI output ignores later theme changes              | **open**    | `ansiToHtml()` still chooses the fixed converter before theme installation.                                                         |
|  15 | Prototype properties can resolve as palette colors            | resolved    | Palette references require own string properties.                                                                                   |
|  16 | Duplicate CodeMirror mappings hide ordinary variable colors   | resolved    | The duplicate variable mapping is removed.                                                                                          |
|  17 | An unrelated smoke-test change is in the implementation range | **open**    | Provider discovery and test-config changes remain in `session-observers-smoke.mjs`.                                                 |

## Findings

### 1. User theme edits still never reload

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `server/src/index.ts:116-127`
- **Status:** open
- **Fix:** Watch the user-theme directory with `fs.watch`, match the configured basename, and debounce reloads.

The plan requires creation, replacement, and edits of `$XDG_CONFIG_HOME/pimote/themes.json` to publish a new catalog revision. The callback still receives `Stats`, not a filename, so the guard cannot detect content edits. The catalog therefore keeps the previous user contribution until restart.

### 2. Existing ANSI output still ignores theme installation

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/ansi-to-html.ts:105-111`
- **Status:** open
- **Fix:** Always use `themedConverter`, which supplies literal fallbacks, and remove `themeInstalled()`.

The fix adds CSS-variable fallbacks to the themed converter, but `ansiToHtml()` still selects the fixed-color converter before theme installation. ANSI text rendered during startup can therefore keep fixed colors after a theme is installed or previewed.

### 3. Unrelated profile events cancel local previews

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/theme-store.svelte.ts:55-58`
- **Status:** open
- **Fix:** Preserve an active preview when an already-reconciled profile event arrives.

Every `user_sessions_changed` event now clears the preview. Session opens, closes, or reorders from another device can discard an unsaved theme choice even when the user's profile selection did not change.

### 4. Warning surfaces use unreadable foreground colors

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/MobileRuntimeStatus.svelte:26,48`
- **Status:** open
- **Fix:** Use `text-status-reconnecting` on translucent warning backgrounds.

The new `bg-warning/10 text-warning-foreground` pairing has approximately 1.07:1 contrast in Pimote Dark. Warning text becomes unreadable on the translucent surface. The same pairing appears in the other changed warning surfaces.

### 5. Deferred bootstrap can overwrite the reconciled theme

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/app.html:9`; `client/src/theme-bootstrap-entry.ts:1-13`; `client/vite.config.ts:7-16`
- **Status:** open
- **Fix:** Emit a self-contained classic bootstrap bundle and retain a parser-blocking head script.

The bootstrap is now an ESM module that imports a hashed chunk, so it runs asynchronously. Application startup can reconcile the server palette before the delayed bootstrap applies an older cached palette, briefly or permanently replacing the server-selected theme.

### 6. Follow server default loses its selected state when the default is unavailable

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/AppearanceSettings.svelte:24-26`
- **Status:** open
- **Fix:** Treat `selectedId === null` as the selected Follow server default option.

When the configured default theme disappears, the active palette falls back to Pimote Light. The component compares the active ID with the unavailable configured default ID, so Follow server default is not marked selected even though the profile follows the default.

### 7. Unrelated smoke-test work remains in the feature diff

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `tools/manual-test/session-observers-smoke/session-observers-smoke.mjs:114-115,146-152`
- **Status:** open
- **Fix:** Move the provider-discovery and test-config hunk to a separate change or revert it.

The implementation range still contains provider/model discovery changes that are not part of the client-themes plan. They expand the feature diff without contributing to theme behavior.
