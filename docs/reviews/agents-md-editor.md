# Review: agents-md-editor

**Plan:** `docs/plans/agents-md-editor.md`
**Diff range:** `fcc5bf1d69a25af2db6db3f31e173f97a49c0322..4810a70`
**Date:** 2026-10-04

## Summary

The plan was implemented faithfully — every architecture item (protocol commands, the `file-edit` deep module, `tag-wrap`, `ConfigFileEditor`, the store, the Dashboard entry) traces to the diff and matches the planned interfaces and behavior. Correctness, however, has two critical data-loss risks in the client dialog: Save can truncate `AGENTS.md` after a failed or unfinished load, and Esc/overlay-close with unsaved edits can leave the editor unreopenable. Both passes ran; plan adherence found two unplanned work items bundled into the implementation commits, and correctness flagged several edge-case and design issues.

## Findings

### 1. Save after a failed or unfinished load can empty the file

- **Category:** code correctness
- **Severity:** critical
- **Location:** `client/src/lib/stores/file-editor.svelte.ts:77-79, 116-135`; `client/src/lib/components/ConfigFileEditor.svelte:100-102, 139`
- **Status:** resolved

`openFile` resets `content` and `baseline` to `''`. If `file_get` fails (permission error, non-UTF-8 file, dropped socket) or hasn't returned yet, `content` stays `''`, `dirty` is false, and Save stays enabled — `save()` checks neither `loading` nor `error`. One click sends `file_put` with `''` and truncates an existing `AGENTS.md`. After a failed load the header also says "New file — it will be created on save," inviting the overwrite. Save should require a completed successful load.

### 2. Esc or overlay-click with unsaved edits leaves the editor hidden until reload

- **Category:** code correctness
- **Severity:** critical
- **Location:** `client/src/lib/components/ConfigFileEditor.svelte:80-82, 90`
- **Status:** resolved

The main dialog takes `open={fileEditorStore.open}` one-way. Esc or an overlay click closes it inside bits-ui (whose root setter overrides the unbound prop locally to `false`), then `onOpenChange(false)` runs. With unsaved edits, `requestClose()` opens the confirmation dialog and leaves `fileEditorStore.open` true — the editor is now hidden while the store says it is open. "Keep editing" doesn't bring it back; the header button calls `openFile`, which sets `open = true`, but that is no change, so the dialog never re-renders. The edits are lost until a page reload. Tests miss this because they drive Cancel, which bypasses bits-ui.

### 3. Out-of-scope branding module is dead code bundled into the implementation commits

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/branding.ts:1-58`; `server/src/config.ts:4, 25-26, 67-68, 99`
- **Status:** dismissed

Nothing in the plan covers app-name branding, yet commit `fcc6f15` bundles `branding.ts` (with tests) and an `appName` config key. Only tests call `resolveAppName`, `applyAppNameToHtml`, and `applyAppNameToManifest`; nothing reads `config.appName`. At HEAD this is a hypothetical seam for a feature that doesn't exist yet, and `loadConfig`'s error text now advertises `appName` to users while nothing consumes it. It hurts reviewability and reverts. (If this belongs to concurrent work whose wiring lands elsewhere, dismiss accordingly.)

### 4. Text typed during loading is silently overwritten

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/file-editor.svelte.ts:126-127`; `client/src/lib/components/ConfigFileEditor.svelte:122-123`
- **Status:** resolved

The editor accepts typing while the file is loading. When `loadFile` resolves it overwrites both `content` and `baseline`, so those keystrokes vanish with no unsaved-changes warning. Easy to hit on a slow mobile link.

### 5. The lazy editor import has no error handling

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/ConfigFileEditor.svelte:21-27`
- **Status:** resolved

The `import()` of `ExtensionCodeEditor` has no catch. A chunk-load failure (stale PWA chunk after a deploy, or offline) yields an unhandled rejection and a dialog stuck on "Loading editor…" with no error state — while, per finding 1, Save can still write whatever is in `content`.

### 6. Saving through a temp file breaks symlinks and resets permissions

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/file-edit.ts:51-63`
- **Status:** resolved

The temp-file-plus-rename write replaces the path itself. If `AGENTS.md` is a symlink into a dotfiles repo (a common setup), it becomes a regular file and the real target never receives the edit. The write also drops the original mode and owner — the temp file gets `0666 & ~umask`, so a `0600` file such as `config.json` (which holds `vapidPrivateKey`) becomes world-readable under a typical umask. Resolve with `realpath` and copy the mode across, or write in place.

### 7. Unplanned ProjectList row restructure bundled into the entry commit

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/ProjectList.svelte:85-92, 160-192, 428-441, 496-577` (commit `1f21239`)
- **Status:** dismissed

The plan's Dashboard entry step specifies one icon button. The same commit also redefines the half-open session filter, makes the whole row a click-to-expand target, moves repo chips/tags to a second row, and relocates "Disband project" into the context menu — real behavior changes to an existing feature with no plan step. Tests were updated to the new semantics rather than weakened. Likely intentional concurrent work; noting per the reverse-check.

### 8. Duplicated dialog-state reset in `FileEditorStore`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/stores/file-editor.svelte.ts:59-71, 101-113`
- **Status:** resolved

`openFile` and `close` each inline the identical per-file state reset (`loading/saving/exists/path/resolvedPath/title/content/baseline/error/snippets`), differing only in `open` and the generation bump. The reset should live in one private function; as written, adding a field will drift one of the two paths.

### 9. `tagSnippets` is parsed twice with different rules

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/config.ts:41-42, 110` vs `client/src/lib/stores/file-editor.svelte.ts:16-27`
- **Status:** dismissed

Nothing on the server reads `PimoteConfig.tagSnippets`, so that parsing is dead. The client re-parses the raw config file with different rules — it drops invalid tag names, the server keeps them. The duplicated operation will drift.

### 10. `resolveFilePath` is labelled "Pure" but isn't, and accepts paths the protocol forbids

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/file-edit.ts:7-15`
- **Status:** resolved

`resolve()` depends on the server's working directory, so the "Pure" label is wrong. Relative paths and `~user/...` paths silently resolve against that directory, and `file_put` would create a literal `~user` folder. The protocol contract says absolute or `~` paths only; other paths should be rejected.

### 11. Ctrl+Shift+G clashes with CodeMirror's own shortcut

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/ConfigFileEditor.svelte:59-64`
- **Status:** resolved

CodeMirror's default setup already binds this key to "find previous" and doesn't stop the key event from reaching the dialog, so with the editor focused one key press opens both the search panel and the tag input.

## No Issues

Both passes produced findings (plan adherence: findings 3 and 7 plus the note below; code correctness: findings 1, 2, 4, 5, 6, 8, 9, 10, 11). No pass was skipped. Aside from the findings above, plan adherence found no missing plan requirements — the wire protocol, `file-edit` seam, `tag-wrap` module, `ConfigFileEditor`, store, snippet transport, and Dashboard entry all match the plan's interfaces and behavioral contracts.
