# Pimote manager guide

Use the manager to locate working folders, continue conversations, curate folders, and change hub membership.

## Routing

| Request                                                     | Route                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| Find a folder or inspect hub membership.                    | `pimote_find_folders`                                   |
| Find conversation history or inspect live session activity. | `pimote_find_sessions`                                  |
| Begin a new conversation.                                   | `pimote_start_session`                                  |
| Continue an existing conversation.                          | `pimote_find_sessions`, then `pimote_resume_session`    |
| Hide unwanted conversations.                                | `pimote_find_sessions`, then `pimote_archive_sessions`  |
| Build a code folder, persona, or hub.                       | `pimote_create_folder`, using `recipes.md`              |
| Change favorites, folder visibility, or tags.               | `pimote_find_folders`, then `pimote_update_folder`      |
| Change a hub's members.                                     | `pimote_find_folders`, then `pimote_update_hub_members` |
| Retire a finished worktree hub.                             | `pimote_find_folders`, then `pimote_disband_hub`        |

When the target is known, narrow the search instead of requesting broad listings.
Keep folder searches separate from conversation searches.

## Continue a saved conversation

Search the history, including archived conversations when needed:

```
pimote_find_sessions { query: "login", includeArchived: true }
```

Use the returned session identifier to continue that conversation:

```
pimote_resume_session { sessionId: "ID_FROM_SEARCH" }
```

For a new conversation, select a known folder instead:

```
pimote_start_session { folderPath: "/srv/repos/app", firstMessage: "Investigate the login failure." }
```

## Folder topology

Select parents from configured scan roots or skipped folders within them that discovery traverses.
Keep parents outside included folders and their descendants.
Discovery treats included folders as leaves, so real folders created beneath them remain undiscovered.

Select hub members through `pimote_find_folders`.
Keep each member in its canonical home and connect it through a shortcut or, in a worktree hub, a nested detached checkout.
The folder listing supplies member identities, not a catalog of safe parent locations.
See `folders.md` for discovery rules and `recipes.md` for the standard shapes.

## Worktree hubs

`pimote_create_folder` takes `memberRepresentation` for hub kinds. Omit it for symlinks, the default. Pass `"worktree"` to materialize code members as nested detached worktrees at their source `HEAD`; persona members always join by symlink. Membership edits follow the hub's mode: `pimote_update_hub_members` detaches new code members in a worktree hub and symlinks them otherwise.

Retire a finished worktree hub with `pimote_disband_hub { hubPath: "..." }`. It removes every nested worktree through Git and deletes the hub directory, without merging, committing, stashing, or deleting branches. It refuses a hub with active sessions or external pi processes, a dirty checkout, or a detached `HEAD` unreachable from a local or remote-tracking branch ref, and keeps the hub on disk for a retry. Symlink hubs reject disband; a symlink hub is deleted by hand like any folder.

## Curation and membership examples

Restore a folder's visibility without moving it:

```
pimote_update_folder { folderPath: "/srv/repos/app", archived: false }
```

Replace a hub member while preserving both canonical homes:

```
pimote_update_hub_members { hubPath: "/srv/repos/platform", remove: ["/srv/repos/old-api"], add: ["/srv/repos/api"] }
```

Disband a worktree hub whose checkouts all pass the guards:

```
pimote_disband_hub { hubPath: "/srv/repos/platform" }
```

The result lists the removed checkout paths (`removedWorktreePaths`).

## Wide searches

The find tools target 16KB of serialized rows inline.
They retain the first row even when it exceeds that budget.
For saved overflow, search the JSONL file named in the result with `jq` or `grep`:

```sh
jq -c 'select(.name // .id | test("PATTERN"; "i"))' /path/from/result.jsonl
```

If saving fails, the result warns that overflow is unavailable and preserves the inline prefix.
Narrow the search to retrieve omitted rows.
Codemode scripts receive all rows without reading spill files.

After manual filesystem changes, wait for discovery cache expiry, then search again.
See `folders.md` for cache behavior.

## Other shipped guides

- `folders.md`: discovery, folder identity, shortcuts, hubs, and curation.
- `recipes.md`: creation examples and topology anti-patterns.
- `static-reports.md`: HTML reports hosted with `pimote_static_host`.
