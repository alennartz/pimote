# Review: Global settings

**Plan:** `docs/plans/global-settings.md`
**Diff range:** `506df5312a4e7a47195c53baff086c5fe9555f2f..453dd20f5d5b85fe93cd4b80fcd09ebf7cf552c7`
**Date:** 2026-10-30

## Summary

The implementation covers the main catalog, runtime, extension host, client store, dialog, and protocol work. The review found critical reload and native-write consistency risks, plus an editor state bug that can save one file's content into another. The plan is also incomplete in package refresh, documentation, and the required configuration-policy matrix.

## Findings

### 1. Package declarations are not refreshed on global reload

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `server/src/index.ts:365-370`
- **Status:** resolved
- **Fix:** Await `packageSettings.reload()` before calling `pimoteExtensionHost.reload()`.

Step 6 requires package settings to refresh during host rediscovery. `DefaultPackageManager.listConfiguredPackages()` reads the cached `SettingsManager`, so packages added or removed with Pi's package manager stay invisible until process restart.

### 2. Discovery failure leaves a stopped runtime and aborts the Pi reload

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/pimote-extensions/index.ts:177-195`, `server/src/index.ts:365-370`, `server/src/ws-handler.ts:1710-1715`
- **Status:** resolved
- **Fix:** Catch discovery/package-manager failures, publish a replacement runtime with diagnostics, and let the session reload continue.

`replaceRuntime()` stops the current runtime before discovery. Package-manager calls and Jiti construction can reject outside the per-entry catch, leaving `this.runtime` pointed at an inactive registry. The global reload then rejects before source replacement, and the WebSocket reload never reaches `session.reload()`.

### 3. Concurrent native-config writes can split disk and live state

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/config-runtime.ts:103-112`
- **Status:** resolved
- **Fix:** Serialize native `putFile()` operations through one promise chain.

Two WebSocket messages can validate and write the native file concurrently. Their atomic renames and `apply()` calls can complete in different orders, leaving the effective in-memory configuration different from the file on disk.

### 4. Undo after switching tabs can save the previous file into the current file

- **Category:** code correctness
- **Severity:** critical
- **Location:** `client/src/lib/components/CodeEditorDialog.svelte:130-135,198-199`, `client/src/lib/components/GlobalSettingsDialog.svelte:89-107`
- **Status:** resolved
- **Fix:** Remount the editor per active path with a keyed block, or replace its `EditorState` when the path changes.

The same CodeMirror instance remains mounted while the active tab changes. The new draft is dispatched into that instance and enters its undo history. Pressing Ctrl-Z immediately after switching can restore the prior tab's text, mark the new tab dirty, and save file A's content to file B.

### 5. README still describes the removed global Agent instructions editor

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `README.md:65,131`
- **Status:** resolved
- **Fix:** Describe the Global Settings manifest and generic file-edit seam instead of the removed home Agent-instructions editor and hard-coded path.

Step 11 requires removal of obsolete hard-coded-path warnings and old UI claims. These passages still say the Dashboard owns an Agent instructions editor, identify one fixed `AGENTS.md` path, and describe `file_get`/`file_put` as that editor's protocol.

### 6. Manual-test documentation still targets the old home journey

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `tools/manual-test/README.md:657-690`
- **Status:** resolved
- **Fix:** Replace or retarget `agents-md-editor-smoke` to drive the Global Settings journey.

The manual-test index still describes the home Agent-instructions button and a single `AGENTS.md` editor. This contradicts the new Settings gear, manifest tabs, per-file drafts, and missing-file flow required by Step 11.

### 7. Codemap, comments, and package metadata retain the old source-loader contract

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `codemap.md:103-109`, `packages/sdk/src/folders/types.ts:43-47`, `server/src/config.ts:30-31`, `packages/sdk/package.json:4`
- **Status:** resolved
- **Fix:** Document the global Pimote host and source-only SDK seam, and mark the legacy config key without claiming production scans `folder-sources` or exposes creation seams.

Step 11 requires the codemap and public guidance to describe `@pimote/sdk/pimote`, the new host, and core-owned folder creation. These locations still describe dynamic imports from the configured folder-sources directory or advertise folder discovery/creation seams.

### 8. The required dynamic/startup configuration matrix is missing

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `README.md:205-253`, `docs/shipped/folders.md:56`
- **Status:** resolved
- **Fix:** Add the exact matrix for new-consumer model, voice, idle-timeout, and buffer behavior, and startup-only roots, manager root, port, VAPID, and voice transport.

The documentation lists individual fields but does not state when changed values take effect. The plan explicitly requires this matrix so users know which existing sessions and transports retain captured values.

### 9. The SDK README extension example does not type-check

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `packages/sdk/README.md:121-135`
- **Status:** resolved
- **Fix:** Call `context.on('shutdown', ...)` without returning its unsubscribe function.

`PimoteExtension` returns `void | Promise<void>`, while `context.on()` returns `() => void`. The documented example returns that unsubscribe function and therefore fails its declared type.

### 10. The mobile dialog is half off-screen at tablet widths

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/CodeEditorDialog.svelte:130-135`, `client/src/lib/components/GlobalSettingsDialog.svelte:166-173`
- **Status:** resolved
- **Fix:** Clear the CSS `translate` property for the mobile variant, or omit the `sm:` centering utilities when the viewport is mobile.

The Dashboard switches to the mobile variant below 768px, but `sm:` centering classes still apply from 640px upward. The Settings mobile rule resets `transform`, not Tailwind's `translate` property, so the full-screen dialog is translated by half its own width and height at 640–767px.

### 11. Duplicate missing paths produce duplicate keyed tabs

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/global-settings.ts:42-52`, `client/src/lib/components/GlobalSettingsDialog.svelte:95-107`
- **Status:** resolved
- **Fix:** Deduplicate by canonical path when present, otherwise by the resolved declared path.

The catalog deduplicates only existing canonical targets. Repeating a missing config or extension path leaves duplicate `path` values. Svelte then throws a duplicate-key error for the tab list, and store lookups address only the first entry.

### 12. Server capabilities do not validate or deduplicate tag snippets

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/config.ts:135-163`, `client/src/lib/components/GlobalSettingsDialog.svelte:128-130`, `client/src/lib/components/ConfigFileEditor.svelte:109-114`
- **Status:** resolved
- **Fix:** Reject or filter invalid tag names and duplicate snippets before advertising them.

`parseConfig()` checks only that snippets are strings. Invalid names are advertised as a validated palette but are rejected silently by `applyWrap()`, while duplicate names crash the keyed snippet lists in both editors.

### 13. Global reload forces a cold folder walk and discards status caches

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/repo-index.ts:674-681`, `server/src/index.ts:365-370`
- **Status:** open
- **Fix:** Preserve warm status caches and avoid blocking the reload on a full discovery walk when a narrower invalidation is sufficient.

Every `/reload` replaces user sources, calls `invalidate()`, and waits for `currentStamp()`. This performs a full roots-and-source walk before the Pi reload and clears all cached git facts, so the next listing must re-probe every repository. Reload latency therefore grows with the workspace size.

### 14. Failed extension factories can leak partial and late registrations

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/pimote-extensions/index.ts:92-126,177-191`
- **Status:** open
- **Fix:** Stage each entry's registrations and commit them only after its factory resolves, then seal the entry context.

A factory that registers a source or file and then throws leaves those registrations in the runtime despite the diagnostic. A timer or other callback can also register after the factory returns, but no later registry replacement reaches the folder index or Settings manifest.

### 15. Shutdown failures are discarded and a hung handler blocks lifecycle operations

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/pimote-extensions/index.ts:133-144`
- **Status:** open
- **Fix:** Surface shutdown diagnostics from the reload and bound handler execution so one handler cannot block reload or process shutdown forever.

Shutdown errors are appended to the old runtime's diagnostics, which is discarded when the replacement registry is published. A handler that never settles blocks every later reload and graceful server shutdown.

## No Issues

- Plan adherence found no significant deviations in Steps 1–5 or 7–10 beyond the findings above.
- The eight test files listed in the plan were unchanged after the pre-implementation commit.
- The approved interaction mock requirements are represented by the store, presentation, and actual-dialog tests.
- No additional correctness findings were identified in the client store or the session-manager consumer suppliers.
