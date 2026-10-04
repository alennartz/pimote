# Plan: AGENTS.md Editor

## Context

A first-class pimote feature to manually edit the user-level `~/.pi/agent/AGENTS.md` from the UI: an unobtrusive home-page button opening the existing dialog-style editor, plus a tag-wrap toolbar. The file-edit seam is deliberately generic ("just a file edit command with path and content"), making this the first citizen of a future server-configuration workflow. See `docs/brainstorms/agents-md-editor.md` for the exploration and settled product decisions.

## Architecture

### Impacted Modules

- **Protocol** (`shared/src/**`) — new generic `file_get` / `file_put` command pair in the server-level group of `PimoteCommand`. No session required. The Android mirror is not extended (its staleness is accepted debt per codemap; this feature is PWA-only).
- **Server** (`server/src/**`) — new `file-edit` module owning path resolution and file read/write; `ws-handler` gains `file_get` / `file_put` cases delegating to it. `PimoteConfig` gains an optional `tagSnippets` key (the user-defined snippet palette). No change to session/manager modules.
- **Web Client** (`client/src/**`) — Dashboard gets one unobtrusive icon button; a new config-file editor dialog composes the existing `ExtensionCodeEditor` with a wrap-tag toolbar; a new pure `tag-wrap` module holds the wrap semantics. `ExtensionCodeEditor`'s interface grows one small seam (editor view access) so the toolbar can wrap the live selection.

Consistent with DR-048: this is a dialog over the dashboard, not a new screen. Consistent with DR-050's posture: the server trusts its own operator with server-readable/writable paths — no path allowlist.

### Interfaces

#### Wire (shared/src/protocol.ts)

```ts
export interface FileGetCommand extends CommandBase {
  type: 'file_get';
  /** Absolute path, or a `~`-prefixed path (the server expands a leading `~`/`~/` to its home directory). */
  path: string;
}

export interface FileGetResponseData {
  /** Resolved absolute path (after `~` expansion). */
  path: string;
  exists: boolean;
  /** UTF-8 text; '' when exists === false. */
  content: string;
}

export interface FilePutCommand extends CommandBase {
  type: 'file_put';
  path: string;
  /** The file's complete new contents. Last-write-wins; no versioning. */
  content: string;
}

export interface FilePutResponseData {
  /** Resolved absolute path. */
  path: string;
}
```

Behavioral contract (both commands, dispatched in `ws-handler` under a new server-level group, no `sessionId` required):

- `~` expansion applies only to a leading `~` or `~/`; anything else is used as-is via `path.resolve`. Empty path → error.
- `file_get` on a missing file: `exists: false`, `content: ''`, success. On a directory, an unreadable file, or a non-UTF-8 read failure: `success: false` with `error` set.
- `file_put` creates parent directories as needed and writes atomically (temp file + rename). It creates the file when missing (the "will create" flow: editor opens on `exists: false`, save materializes the file).
- Errors surface as the standard `PimoteResponse` shape: `{ id, success: false, error: string }`.

#### Server module — `server/src/file-edit.ts`

Deep module: three functions, all the path/file semantics behind them.

```ts
/** Pure. Expands leading `~`/`~/` against homeDir; resolves otherwise. Throws on empty path. */
export function resolveFilePath(path: string, homeDir: string): string;

/** Resolves, reads UTF-8. Missing file → { path, exists: false, content: '' }. */
export function readEditableFile(path: string): Promise<FileGetResponseData>;

/** Resolves, mkdir -p parent, atomic write (temp + rename). Returns { path }. */
export function writeEditableFile(path: string, content: string): Promise<FilePutResponseData>;
```

Testable through this interface: `resolveFilePath` is pure; the read/write functions are exercised against temp directories.

#### Client — pure wrap module `client/src/lib/tag-wrap.ts`

```ts
export type TagWrapResult = { text: string; from: number; to: number };

/** Tag names: /^[A-Za-z][A-Za-z0-9_-]*$/; anything else throws. */
export function isValidTagName(tag: string): boolean;

/**
 * Pure. Returns the new document text plus the selection to restore.
 * - Selection (from < to): inline wrap — '<tag>' at from, '</tag>' at to;
 *   resulting selection is the original inner range, shifted past the open tag.
 * - Cursor (from === to): inserts '<tag>\n\n</tag>' at the cursor (tags each on
 *   their own line, blank line between); resulting selection is collapsed on
 *   the blank middle line.
 */
export function wrapWithTag(value: string, from: number, to: number, tag: string): TagWrapResult;
```

#### Client — editor dialog

- `ExtensionCodeEditor` gains an optional `bind:editorView` (or equivalent callback) exposing the CodeMirror `EditorView`, so the toolbar can read `view.state.selection.main` and dispatch the wrap transaction. The existing `value` binding keeps working unchanged.
- New `ConfigFileEditor.svelte` dialog (styled/sized like `ExtensionDialog`, which already goes full-screen below `sm` and centered above — desktop/mobile behavior inherited). Contents: `ExtensionCodeEditor` in markdown mode + toolbar (tag input, Wrap action, snippet buttons) + Save/Cancel.
  - Tag button toggles a one-line input; Enter or Wrap applies `wrapWithTag` to the current selection. Desktop additionally gets a Ctrl+Shift+G shortcut to focus the input.
  - Snippet buttons apply `wrapWithTag` with their tag directly.
  - Save → `file_put`; success closes the dialog. Cancel/close with unsaved changes asks for confirmation. No conflict detection (last-write-wins, per brainstorm).
- New small store `client/src/lib/stores/file-editor.svelte.ts`: dialog open/closed, `exists`, content, `dirty`, `saving`, `error`, snippets.

#### Snippet transport

Snippets live in `PimoteConfig.tagSnippets?: string[]` (`~/.config/pimote/config.json`), per brainstorm. There is no existing server-info channel over WS, and the seam is deliberately generic — so the client fetches the config file with `file_get` on `~/.config/pimote/config.json` and parses `tagSnippets` leniently (missing file, invalid JSON, or absent key → no snippet buttons, never blocks the editor). Known limitation: a custom `XDG_CONFIG_HOME` is not honored by this tilde path; accepted for now — the future config workflow is the place to surface server-resolved paths.

#### Known gaps

- Mobile soft-keyboard behavior (CodeMirror + virtual keyboard, dvh shrink, focus scroll) is unverified. Per user decision: architecture stays as-is, and this gets at most light manual attention — no design work preemptively.

#### Dashboard entry

One unobtrusive icon button in the Dashboard home header (projects column header on desktop, the home header row on mobile) labeled "Agent instructions"; opens the dialog targeting `~/.pi/agent/AGENTS.md` via `file_get`.

## Tests

> **Skipped.** No tests were written upfront. Follow red-green TDD as you implement —
> write a focused failing test, make it pass, move on. Aim for component-boundary
> behavioral tests (inputs, outputs, observable effects), not exhaustive coverage.

## Steps

> **Skipped.** Work through the architecture methodically — identify affected files, make changes in a logical order, and commit in coherent units.
