# Plan: Create Project Folder

## Context

Add the ability to create a new project folder under a configured root from the pimote UI. Currently folder discovery is read-only — users must SSH in to create new projects. See [brainstorm](../brainstorms/create-project-folder.md).

## Architecture

### Impacted Modules

**Protocol** — new `create_project` command type added to the `PimoteCommand` union. The existing `list_folders` response is enriched to include the configured roots alongside the folder list.

**Server** — ws-handler gets a new `create_project` case: validate name and root, `mkdir` + `git init`, return the created folder path. `FolderIndex` exposes a `roots` getter so the ws-handler can (a) validate the root in `create_project` and (b) include roots in the `list_folders` response.

**Client** — `FolderList.svelte`'s new session picker dialog gains a "Create new project" flow. Clicking it transitions the dialog into creation mode: root selection (skipped if single root) → name input → create → open session. The `IndexStore` is updated to store and expose roots from the `list_folders` response. No new components — all contained within the existing dialog.

### Interfaces

**Protocol additions:**

```typescript
// New command
interface CreateProjectCommand extends CommandBase {
  type: 'create_project';
  root: string; // must be one of the configured roots
  name: string; // folder name — no slashes, non-empty
}

// Added to PimoteCommand union
```

The `list_folders` response data shape changes from `{ folders: FolderInfo[] }` to `{ folders: FolderInfo[], roots: string[] }`.

The `create_project` success response data: `{ folderPath: string }` — the full path of the created directory.

Error cases returned as `{ success: false, error: string }`:

- Name is empty or contains path separators
- Name is `.` or `..`
- Root is not one of the configured roots
- Directory already exists
- `mkdir` or `git init` fails

**Server — FolderIndex:**

```typescript
// New public getter
get roots(): string[]   // returns the configured roots array
```

**Server — ws-handler `create_project` case:**

Validation order: name format → root membership → directory existence → filesystem ops (`mkdir` + `git init`). No index refresh needed — `FolderIndex.scan()` does a fresh `readdir` on every call, so the next `list_folders` picks up the new directory automatically.

**Client — IndexStore:**

Stores `roots: string[]` from the `list_folders` response. Exposes it reactively so `FolderList.svelte` can use it for the creation flow.

**Client — FolderList.svelte dialog flow:**

The new session picker dialog gains a creation sub-flow:

- A "Create new project" button in the dialog (always visible, e.g. below the project list or in the footer)
- If `roots.length > 1`: show root selection step
- If `roots.length === 1`: skip to name input with the single root pre-selected
- Name input with validation feedback and a "Create" action
- On success: calls existing `newSession(folderPath)` which issues `open_session`
- Back/cancel returns to the normal project picker view

## Tests

> **Skipped.** No tests were written upfront. Follow red-green TDD as you implement —
> write a focused failing test, make it pass, move on. Aim for component-boundary
> behavioral tests (inputs, outputs, observable effects), not exhaustive coverage.

## Steps

> **Skipped.** Work through the architecture methodically — identify affected files,
> make changes in a logical order, and commit in coherent units.
