# Review: client-themes

**Plan:** `docs/plans/client-themes.md`  
**Diff range:** `669b46af250a96903d5d6ba5b929ff95aeb6ee79..1a64ef6`  
**Date:** 2026-11-19

## Summary

The implementation covers the planned theme surfaces, but several required flows remain broken. User-file edits do not reload, Save can remain disabled after a preview, and stale cached palettes can leak across report-user changes. The implementation also leaves fixed component colors, diverges from the approved paired preview mock, and contains independent rendering and reload correctness bugs.

## Findings

### 1. User theme edits never reload

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `server/src/index.ts:116-125`
- **Status:** resolved
- **Fix:** Watch the user-theme directory with `fs.watch`, match the configured basename, and debounce reloads.

The plan requires creation, replacement, and edits of `$XDG_CONFIG_HOME/pimote/themes.json` to publish a new catalog revision. The callback receives `Stats`, not a filename, so the guard returns before reloading. Directory stat polling also cannot detect file content changes reliably. Valid user theme edits therefore remain invisible until restart.

### 2. Save stays disabled after selecting a preview

- **Category:** code correctness
- **Severity:** critical
- **Location:** `client/src/lib/stores/theme-store.svelte.ts:27,97-98`
- **Status:** resolved
- **Fix:** Declare `previewing` as `$state(false)`.

`previewing` is a plain private variable while `saveDisabled` participates in Svelte rendering. After reconciliation, selecting a theme changes the direct getter but does not invalidate the rendered Save button, so production users cannot save a newly previewed theme.

### 3. Unsaved previews enter the shared cache

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `client/src/lib/stores/theme-store.svelte.ts:120-130`
- **Status:** resolved
- **Fix:** Write the shared cache only for saved selections, then update it on save, cancel, and profile adoption.

`applyActive()` caches every applied theme, including local previews. The plan limits the cache to the saved resolved theme, so report tabs and other contexts can adopt a choice that the user has not saved.

### 4. Report bridges retain the previous user's palette

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `client/src/lib/theme-bridge.ts:201-229`; `client/static/pwa/theme-bridge.js:193-206`
- **Status:** resolved
- **Fix:** Restore captured fallback styles for null or invalid cache data and use one shared validator for both bridge entries.

When a user changes to an identity with no cache, or a cache becomes invalid, both bridges return without removing the previously applied custom properties. A report can therefore keep the former user's palette. The hand-written static entry also accepts cache data without `source`, unlike the TypeScript validator, so the two public paths do not enforce the same contract.

### 5. Fixed component colors override themes

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `client/src/lib/components/ExtensionStatus.svelte:142`; `client/src/lib/components/MobileRuntimeStatus.svelte:26-53`; `client/src/lib/components/SessionDetailsDialog.svelte:49-61,183-193`; `client/src/lib/components/SwipeableCard.svelte:317-334`; `client/src/lib/components/FolderList.svelte:506-560,758`; `client/src/routes/+layout.svelte:272-277`
- **Status:** resolved
- **Fix:** Replace fixed palette classes and dark-only branches with the existing semantic theme tokens and `color-mix()` variants.

Step 12 requires a complete audit of color-valued component and route styles. These fixed Tailwind palette utilities and dark-only branches remain, so status, dialog, folder, swipe, and layout surfaces can override the selected theme during preview or after save.

### 6. Extension file edits survive reload

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/theme-catalog.ts:449-453`
- **Status:** resolved
- **Fix:** Reload registered file contents even when the registration paths are unchanged.

Reloading an extension with the same registered path skips reading the file again. Editing a registered theme file and running `/reload` therefore leaves the old colors active.

### 7. Third-party palettes leave required roles indistinguishable

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/builtin-themes.ts:503-509`
- **Status:** resolved
- **Fix:** Supply role-specific literals for the missing surface and UI colors in each third-party palette.

The six third-party built-ins assign the background color to unspecified surface and UI roles. Carets, selections, line numbers, and status indicators then use the same color as their background or another unintended role, making them invisible or unusable.

### 8. Closing settings can preserve an unsaved theme

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `client/src/lib/components/GlobalSettingsDialog.svelte:215-217,248-251`; `client/src/lib/components/AppearanceSettings.svelte:14,41,64`
- **Status:** resolved
- **Fix:** Call `themeStore.cancel()` on every dialog-close path and expose preview/effective selection state for status and `aria-selected`.

Closing after switching away from Appearance skips cancellation, so a mobile Close path can leave an unsaved palette applied and cached. The derived status also labels an existing non-null saved selection as a preview, while Follow server default uses the saved ID instead of the effective preview ID. These states drift from the mock and the cancel contract.

### 9. Theme save failures become unhandled rejections

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/GlobalSettingsDialog.svelte:197,220-221`
- **Status:** resolved
- **Fix:** Catch save failures and display the error in the dialog.

The Appearance pane suppresses save errors while the dialog does not handle the rejected promise. A failed `set_theme` request produces an unhandled rejection and gives the user no visible result or recovery path.

### 10. Bootstrap and report assets duplicate the source modules

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `client/static/pwa/theme-bootstrap.js:1-193`; `client/static/pwa/theme-bridge.js:1-207`; `client/vite.config.ts`
- **Status:** resolved
- **Fix:** Add Vite browser entries that import the shared TypeScript modules and emit the two stable asset paths.

Steps 9 and 13 require stable assets backed by `bootstrapCachedTheme` and `startReportThemeBridge`. The implementation keeps hand-written copies in `client/static`, with no Vite entry. The copies can drift from the application implementation and already have different cache validation behavior.

### 11. Appearance cards do not implement the approved paired preview

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `client/src/lib/components/AppearanceSettings.svelte:36-80`
- **Status:** resolved
- **Fix:** Render each card with the mock's miniature interface panel and code-editor preview.

The linked interaction mock requires every theme card to preview both UI and code palettes. The component shows four color dots instead of the paired mini-window, so desktop and mobile Appearance flows do not match the approved interaction oracle.

### 12. Theme guides omit required role details

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `docs/shipped/themes.md:17,26-28`; `packages/sdk/docs/themes.md:17-21`
- **Status:** resolved
- **Fix:** Enumerate every required UI and syntax role and provide a complete standalone-theme example, or mark an example explicitly abbreviated.

Step 14 requires the guides to document the versioned shape and all required roles. Both guides abbreviate role lists and show an incomplete standalone example, so extension authors and session agents cannot use the documentation as the schema contract.

### 13. CodeMirror keeps dark mode after switching to light

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/ExtensionCodeEditor.svelte:171,243-245`
- **Status:** resolved
- **Fix:** Remove the `{ dark }` option from the layout-only theme and let the reconfigurable theme control the dark facet.

An editor mounted while the application is dark retains the fixed layout theme's `dark: true` after switching to a light theme. CodeMirror's dark facet remains enabled, so renderer behavior can disagree with the active palette.

### 14. Existing ANSI output ignores later theme changes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/ansi-to-html.ts:105-111`
- **Status:** resolved
- **Fix:** Emit terminal CSS variables with literal fallback colors for standard ANSI slots.

ANSI text rendered before theme installation receives fixed hexadecimal colors. Installing or previewing a theme does not rerender that text, so existing output keeps the old palette instead of following the active terminal variables.

### 15. Prototype properties can resolve as palette colors

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/theme-catalog.ts:307-308`
- **Status:** resolved
- **Fix:** Require an own palette property whose value is a string before resolving a palette reference.

A palette reference such as `toString` resolves an inherited object property instead of failing validation. The resulting function can enter a resolved color map and disappear during JSON serialization, violating the catalog's validated-color contract.

### 16. Duplicate CodeMirror mappings hide ordinary variable colors

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/codemirror-theme.ts:11-14`
- **Status:** resolved
- **Fix:** Remove the duplicate `tags.variableName` mapping.

The second `tags.variableName` entry overrides the ordinary variable color with the parameter color. Custom themes therefore cannot render regular variable references with their selected syntax role.

### 17. An unrelated smoke-test change is in the implementation range

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `tools/manual-test/session-observers-smoke/session-observers-smoke.mjs:96-105`
- **Status:** resolved
- **Fix:** Move this six-line provider/model discovery hunk to a separate change or revert it.

The diff includes provider/model discovery work that is not part of the client-themes plan. It increases review and release scope without contributing to the feature.
