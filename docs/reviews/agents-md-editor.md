# Review: agents-md-editor (re-review — fix verification)

**Plan:** `docs/plans/agents-md-editor.md`
**Diff range:** `4810a70..b2491c4` — fix commits `4b87bad`, `d5e6872` (`4d79136` and `b2491c4` are review-doc bookkeeping)
**Baseline:** first review written against `fcc5bf1d..4810a70`, then deleted for this cycle
**Date:** 2026-10-04

## Summary

The fixes land well: both critical findings are resolved with behavior actually pinned by new tests, three of the four warnings are resolved, and four of the five nits are resolved. The fix diff introduces no bugs — only two new nits (some duplicated close-path logic and a few test gaps). Two caveats worth reading: finding 6's fix covers symlinks and file mode but not ownership, and findings 3 and 9 were marked `dismissed` in the old review doc without any recorded rationale.

## Prior Findings

### 1. Save after a failed or unfinished load can empty the file

- **Category:** code correctness
- **Severity:** critical
- **Location:** `client/src/lib/stores/file-editor.svelte.ts` (`loaded` flag, `save()` guard); `client/src/lib/components/ConfigFileEditor.svelte` (Save button, hint)
- **Status:** resolved

The store's new `loaded` flag is set only after a successful `file_get`, and `save()` refuses to run without it. Save is disabled until then, and the "New file — it will be created on save" hint shows only after a completed load. Tests pin both sides: no `file_put` after a failed load or while loading (store tests), Save disabled and hint hidden (component tests).

### 2. Esc or overlay-click with unsaved edits leaves the editor hidden until reload

- **Category:** code correctness
- **Severity:** critical
- **Location:** `client/src/lib/components/ConfigFileEditor.svelte:123, 127-128, 101-106`
- **Status:** resolved

The dialog now uses `bind:open={fileEditorStore.open}`, so bits-ui and the store share one value. `onEscapeKeydown`/`onInteractOutside` route through `onDismissAttempt`, which vetoes the close (`preventDefault`) when edits exist and opens the discard confirmation — the editor dialog never closes. A test asserts the dialog stays `data-state="open"` after Esc and that "Keep editing" restores a working editor with edits intact. Residual gap (nit-level): overlay-click itself is untested, though it uses the same handler.

### 3. Out-of-scope branding module is dead code bundled into the implementation commits

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/branding.ts:1-58`; `server/src/config.ts:26, 68, 99`
- **Status:** dismissed

Dismissed by the fix author on the concurrent-work carve-out (repo policy: treat concurrent changes as intentional); no code change. Caveat recorded here since the old doc is gone: at `d5e6872` the branding helpers still have no non-test callers, and `loadConfig`'s help text still advertises `appName` as a config key that nothing consumes. If stricter handling is wanted, the minimal ask is that one misleading help line.

### 4. Text typed during loading is silently overwritten

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/stores/file-editor.svelte.ts`; `client/src/lib/components/ConfigFileEditor.svelte`
- **Status:** resolved

The editor is not mounted until both the CodeMirror module has loaded and `fileEditorStore.loaded` is true, so nothing can be typed before the load completes. A test asserts no `.cm-editor` exists (and Save is disabled) while `file_get` is pending.

### 5. The lazy editor import has no error handling

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/ConfigFileEditor.svelte:21-27`
- **Status:** resolved

The `import()` now has a `.catch` that sets an error state and shows an error message instead of hanging on "Loading editor…". Closing the dialog clears the error, so reopening retries. `ConfigFileEditor-load-failure.test.ts` forces the import to fail and asserts the error shows. Residual gap (nit-level): the retry-on-reopen path is untested.

### 6. Saving through a temp file breaks symlinks and resets permissions

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/file-edit.ts:42-63, 98-102`
- **Status:** resolved

`realPathForWrite` follows the symlink chain (including dangling links, 40-hop limit) and writes to the real target; `existingFileMode` copies the existing permission bits onto the temp file before rename. Tests cover a symlinked target still being a symlink afterwards, a dangling symlink, and a `0600` file staying `0600`. Residual: the file owner is not preserved — the renamed file belongs to the server's user. Only matters if the server runs as a different user than the file owner; acceptable for this feature's posture.

### 7. Unplanned ProjectList row restructure bundled into the entry commit

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/ProjectList.svelte` (commit `1f21239`)
- **Status:** dismissed

Dismissed by the fix author on the same concurrent-work carve-out. Unlike finding 3, the work here is complete and tested, so the dismissal leaves no residual defect — the behavior change simply remains unattributed to any plan step.

### 8. Duplicated dialog-state reset in `FileEditorStore`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/stores/file-editor.svelte.ts` (`resetFileState()`, ~105-117)
- **Status:** resolved

The reset is extracted into a private `resetFileState()` called by both `openFile` and `close` (which now differ only in `open` and the generation bump). The new `loaded` flag was added to the shared reset, so the fix holds against future drift.

### 9. `tagSnippets` is parsed twice with different rules

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/config.ts:41-42, 110` vs `client/src/lib/stores/file-editor.svelte.ts:16-27`
- **Status:** dismissed

Marked `dismissed` in the old review doc with no stated reason and no code change. The dead server-side parse and the divergent client re-parse both remain. The rationale should be written down — "keep the config type documented" is a plausible one, but it is not recorded anywhere.

**Dismissal rationale (recorded per this re-review):** planned duplication per the plan's snippet-transport section — no server-info channel exists, so the client re-parses `config.json` leniently.

### 10. `resolveFilePath` is labelled "Pure" but isn't, and accepts paths the protocol forbids

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/file-edit.ts:7-15`; `shared/src/protocol.ts`
- **Status:** resolved

Resolved by changing the contract rather than rejecting paths: the "Pure" label is gone, and the protocol comment now states that relative paths are allowed and resolve against the server's working directory. Code and contract agree — and this realigns with the plan's own "anything else is used as-is via `path.resolve`". Residual edge: `~user/...` counts as relative and would write to `<cwd>/~user/...`, surprising but consistent with the documented contract.

### 11. Ctrl+Shift+G clashes with CodeMirror's own shortcut

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/ConfigFileEditor.svelte:59-64`
- **Status:** resolved

The shortcut is now handled by a capture-phase `keydown` listener on the dialog that calls `preventDefault()` and `stopPropagation()`, so CodeMirror's find-previous never fires. A test sends the key to the editor and asserts no search panel (`.cm-panel`) opens while the tag input does.

## New Findings

### 12. Discard-confirmation flow duplicated across two close paths, with a no-op assignment

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/ConfigFileEditor.svelte:90-96, 101-106`
- **Status:** resolved

`requestClose` and `onDismissAttempt` each inline the same operation — `confirmDiscardOpen = true; fileEditorStore.open = true` — with divergent bodies. In `requestClose` the `fileEditorStore.open = true` is a no-op: its only caller is the Cancel button (`:179`), reached with the dialog already open (`onOpenChange(false)` can't arrive with dirty state, since Esc/overlay are vetoed). Its comment ("keep the store and dialog open together") implies it is load-bearing. Per design doctrine each business operation belongs in one function; the two close paths drifting apart is exactly what finding 2 was, so collapsing them now is cheap insurance.

### 13. The fix's new tests leave three behaviors unpinned

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/ConfigFileEditor.test.ts`; `client/src/lib/components/ConfigFileEditor-load-failure.test.ts`; `server/src/file-edit.test.ts`
- **Status:** resolved

The added coverage is good but misses: overlay-click with unsaved edits (finding 2's second trigger), retrying the editor load after closing and reopening (finding 5's recovery path), and a symlink chain with a relative link target (handled correctly in `realPathForWrite` via `resolve(dirname(current), link)`, but unpinned).

## No Issues

Both verification passes ran (plan adherence and code correctness, each scoped to the fix diff and their prior findings). No new critical or warning issues were found in the fix diff; the only newly introduced issues are the two nits above.
