# Review: Create Project Folder

**Plan:** `docs/plans/create-project-folder.md`
**Diff range:** `f697109..e40a99e`
**Date:** 2026-04-16

## Summary

The plan was implemented faithfully — all protocol additions, server validation, FolderIndex changes, IndexStore integration, and the client dialog flow match the specification. Two code correctness warnings were found: a UI error display race where the dialog closes before `open_session` can fail, and a blanket `stat()` catch that masks permission errors. No critical issues.

## Findings

### 1. Error on failed `open_session` written to already-hidden dialog

- **Category:** code correctness
- **Severity:** warning
- **Location:** `client/src/lib/components/FolderList.svelte:192-199`
- **Status:** resolved

After `create_project` succeeds, `showNewSessionDialog` is set to `false` on line 192 _before_ `open_session` is awaited on line 196. If `open_session` throws (network error, server failure), the catch block sets `createError` and `creating = false` — but the dialog is already closed, so the user never sees the error. The project was created on disk but the session wasn't opened, leaving the user with no feedback and no open session.

### 2. `stat()` blanket catch treats permission errors as "not found"

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:229-233`
- **Status:** resolved

The existence check uses `stat()` in a try/catch that assumes _any_ error means the directory doesn't exist. If `stat()` fails with `EPERM` or `EACCES` (permission denied on the parent directory), the code proceeds to `mkdir` rather than reporting the actual problem. Checking for `err.code === 'ENOENT'` specifically would make the intent explicit and avoid masking unexpected filesystem states.

### 3. `createProject()` inlines session opening instead of calling `newSession()`

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/FolderList.svelte:192-196`
- **Status:** open

The plan says "On success: calls existing `newSession(folderPath)` which issues `open_session`." The implementation inlines the logic instead — closing the dialog, calling `onSessionSelect?.()`, firing `loadFolders()`, and sending `open_session` directly. This is a reasonable adaptation: `createProject()` needs the extra `loadFolders()` call so the new project appears in the sidebar, which the existing `newSession()` doesn't do.

### 4. "Create new project" button conditionally visible instead of always visible

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/FolderList.svelte:393-397`
- **Status:** open

The plan says the button is "always visible." The implementation only shows it when `indexStore.roots.length > 0`. This is a correct UX improvement — with zero roots configured, the creation flow has nowhere to create a project and the server would reject the request.

### 5. Redundant trim in `validateProjectName`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/components/FolderList.svelte:161`
- **Status:** open

`validateProjectName` calls `name.trim()`, but its only caller (`createProject`) already passes `createName.trim()`. The `'Name is required'` check on the trimmed-of-a-trimmed value could never trigger via the current call site. Not a bug — just dead validation logic.

## No Issues

Plan adherence: no significant deviations found. All planned protocol additions, server validation logic, FolderIndex changes, IndexStore integration, and dialog flow steps were implemented correctly and in the specified order.
