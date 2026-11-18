# Pimote manager tools

Use these tools to find folders and conversations, start and continue work, curate folders, and manage hubs. Read `folders.md`, `hubs.md`, and `sessions.md` before you change folder structure or session state.

## When the tools exist

Pimote attaches the manager extension to one session: the session whose working directory canonicalizes to the manager root. `managerRoot` in the native config sets that path. The default is `$XDG_STATE_HOME/pimote/manager`. See `settings.md`.

Attachment requires exact path equality. A session in a subdirectory of the manager root gets no manager tools, and a folder session gets none of the folder tools. Those sessions work with the dashboard instead.

The manager root never appears as a folder row. No tool can start a session there.

The static-host and file-download tools come from separate extensions and exist in every session. See `delivery.md`.

## Locate folders

`pimote_find_folders` returns discovered folders with identity, curation, hub shape, git facts, and live counts.

| Parameter         | Type                    | Default | Meaning                                                                                               |
| ----------------- | ----------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `query`           | string                  | none    | Case-insensitive substring of folder name, path, tags, or persona display name. Blank counts as none. |
| `nature`          | `"code"` \| `"persona"` | both    | Keep one nature.                                                                                      |
| `hub`             | boolean                 | both    | `true` keeps hubs, `false` keeps non-hubs.                                                            |
| `includeArchived` | boolean                 | `false` | Include archived folders.                                                                             |

Rows sort by favorite first, then by name. The query matches folder text only. Session content lives in `pimote_find_sessions`.

A row carries these fields:

| Field                  | Meaning                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `path`                 | Canonical path. The folder identity and the curation key.                                  |
| `name`                 | Folder basename.                                                                           |
| `nature`               | `code` or `persona`.                                                                       |
| `persona`              | `name` and `description` from the persona marker.                                          |
| `favorite`, `archived` | Curation flags.                                                                            |
| `tags`                 | Source tags, inherited member tags, and user tags.                                         |
| `userTags`             | User tags set on this path alone.                                                          |
| `hub`                  | `representation`: `symlink` or `worktree`. Present on hubs.                                |
| `members`              | Hub membership. Each entry has `path`, `name`, `nature`, `representation`, `worktreePath`. |
| `repos`, `repo`        | Git facts for hub code members, or for a plain code folder.                                |
| `shortcutCount`        | Symlink members. Worktree members are real directories, so they do not count.              |
| `activeSessionCount`   | Open sessions in the folder.                                                               |
| `externalProcessCount` | pi processes Pimote did not start.                                                         |
| `lastActivity`         | Epoch milliseconds of the newest session activity.                                         |
| `missing`              | `true` for a source-listed folder absent on disk.                                          |

Git facts arrive from a shared status probe. A row can return before its probe finishes, with `branch: null`, `dirty: false`, and zero `ahead` and `behind`. Read again before you call a folder clean.

## Locate conversations

`pimote_find_sessions` returns saved session records with live state merged in, newest first.

| Parameter         | Type    | Default      | Meaning                                                                   |
| ----------------- | ------- | ------------ | ------------------------------------------------------------------------- |
| `query`           | string  | none         | Case-insensitive substring of the session name or the full first message. |
| `folderPath`      | string  | every folder | Canonical path of one known folder.                                       |
| `open`            | boolean | `false`      | `true` keeps only sessions held by a live slot. `false` filters nothing.  |
| `includeArchived` | boolean | `false`      | Include archived sessions.                                                |

A row carries `id`, `name`, `firstMessage` (whitespace collapsed, cut at 200 characters), `modified`, `folderPath`, `open`, `archived`, and `messageCount`. Open sessions also carry `status` (`working` or `idle`) and `needsAttention`.

Sessions in archived folders still appear. The folder filter applies to `pimote_find_folders` only.

The tools paginate nothing. Narrow with `query`, `folderPath`, `nature`, or `hub` instead of reading a wide listing.

## Start, resume, archive

| Tool                      | Parameters                            | Result                                            |
| ------------------------- | ------------------------------------- | ------------------------------------------------- |
| `pimote_start_session`    | `folderPath`, optional `firstMessage` | `sessionId`, `folderPath`, `firstMessageSent`     |
| `pimote_resume_session`   | `sessionId`                           | `sessionId`, `folderPath`, `outcome`              |
| `pimote_archive_sessions` | `sessionIds` (at least one)           | `results`, one `{sessionId, outcome}` per request |

`firstMessageSent` reports that Pimote requested a dispatch. It does not report that the run finished. A dispatch failure reaches the server log only. Read the session with `find_sessions` to check on it.

`resume_session` reopens the original record and clears its archive flag. It never creates a session. Outcomes are `resumed`, `already_open`, and `not_found`.

`archive_sessions` hides records without deleting them. It closes any live runtime and its observers, so a running turn stops. Outcomes are `archived` (record only), `open_slot_evicted` (a live slot was closed first), and `not_found`.

Start a session only in a folder with `missing` absent. A row that is archived is a valid target.

## Create and curate folders

`pimote_create_folder` builds one of four folder kinds. Read `recipes.md` before you call it.

| Parameter              | Type                                         | Default   | Meaning                                                                                                          |
| ---------------------- | -------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `kind`                 | `code`, `persona`, `code-hub`, `persona-hub` | required  | Folder shape to create.                                                                                          |
| `name`                 | string                                       | required  | New basename. One segment, not `.` or `..`, with no existing destination.                                        |
| `parentPath`           | string                                       | required  | Existing path at or below a scan root.                                                                           |
| `memberPaths`          | string[]                                     | none      | Hub kinds only. Canonical paths of known folders, at least one, with unique basenames.                           |
| `memberRepresentation` | `"symlink"` \| `"worktree"`                  | `symlink` | Hub kinds only. Code member layout.                                                                              |
| `description`          | string                                       | none      | Persona kinds only. Required. Written to the marker front matter.                                                |
| `prompt`               | string                                       | none      | Persona kinds only. Persona folders prepend it to the shipped template. Persona hubs use it as the persona text. |
| `body`                 | string                                       | none      | Code kinds only. Text for the seeded `AGENTS.md`.                                                                |

`parentPath` must sit at or below a configured scan root. The tool checks root containment only. It does not check that discovery reaches the new folder. Read `folders.md` for the placement rules that make a folder discoverable.

`pimote_update_folder` changes curation. It never moves or deletes a directory.

| Parameter    | Type     | Default   | Meaning                                                     |
| ------------ | -------- | --------- | ----------------------------------------------------------- |
| `folderPath` | string   | required  | Canonical path of a known folder.                           |
| `favorite`   | boolean  | unchanged | Favorite flag.                                              |
| `archived`   | boolean  | unchanged | Hide the folder from default listings. `false` restores it. |
| `addTags`    | string[] | none      | Tags to add. Trimmed, blanks ignored.                       |
| `removeTags` | string[] | none      | Exact user tags to delete. Applied after additions.         |

A patch with no flags and no tag entries returns an error. An empty tag array is no patch.

## Change hub membership

`pimote_update_hub_members` takes `hubPath` with `add` and `remove` path arrays. It removes before it adds and returns one independent `{memberPath, action, outcome, error?}` per request. One member's failure does not stop the batch. Read `hubs.md` before you change a hub.

`pimote_disband_hub` takes `hubPath` and returns `removedWorktreePaths`. It deletes a worktree hub after its guards pass. See `hubs.md`.

## Read the results

Errors arrive as a payload `{"error": "<message>"}` with the error flag set. Read the field. Do not parse the prose.

A "known folder" error names the recovery: call `pimote_find_folders` and retry with the exact `path` value from a row. A symlinked or `~`-relative path is not a folder identity.

`pimote_resume_session` and `pimote_archive_sessions` report a port failure as a tool error. Recover by reading the session state again.

## Wide results

Both find tools keep a model-facing prefix of serialized rows under 16 KiB. They retain the first row even when it alone exceeds the budget. Further rows go to a JSONL file, one row per line, in result order:

```text
$XDG_STATE_HOME/pimote/tool-spill/<tool>-<timestamp>-<random>.jsonl
```

The result carries `spill` with `file`, `rows`, `bytes`, and a `hint`. Search the file with `jq` or `grep`:

```sh
jq -c 'select((.path // .name // "") | test("PATTERN"; "i"))' /path/from/result.jsonl
```

Spill files live 24 hours. A failed save returns a `warning` and keeps the inline prefix. Narrow the filters to read the omitted rows.

A codemode script reads every row without the spill file. The model-facing view is truncated. The structured payload is complete.

## Interruption

An interrupted turn stops a find call at once. Folder reads and cache fills that already started still finish for the next caller. A mutation that started completes.

## Freshness

Reads serve the discovery cache. A cold cache blocks the first read. A stale entry serves while a background refresh runs, so two calls inside one 30-second window can disagree. See `folders.md`.

Creation, membership, and disband calls invalidate discovery at once.
