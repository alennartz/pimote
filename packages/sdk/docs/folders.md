# Folders

The folders module defines the source contract for folder discovery. A source contributes repos and hub folders to the same listing that the filesystem walk fills, so a folder that no scan root can reach still appears in the dashboard.

Register a source from a Pimote extension with `context.folders.registerSource(source)`. See [authoring.md](authoring.md).

## Contract

```ts
interface FolderSource {
  readonly id: string;
  list(): Promise<SourceEntry[]>;
  onFolderOpen?(folderPath: string): Promise<void>;
}
```

| Member         | Contract                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- |
| `id`           | Non-empty string. Identifies the source in diagnostics.                                   |
| `list`         | Return current entries. Called on a listing cache miss. It must not mutate anything.      |
| `onFolderOpen` | Optional. Awaited before an open proceeds. A throw aborts the open and shows the message. |

A source that throws in `list` is skipped for that listing and logs a warning. The remaining sources and the filesystem walk still serve rows.

## Entries

`list` returns `SourceEntry[]`: repo entries and hub entries.

```ts
interface RepoSourceEntry extends RepoInfo {
  kind: 'repo';
}

interface HubSourceEntry {
  kind: 'hub';
  path: string;
  name: string;
  memberPaths: string[];
  tags?: string[];
}
```

`kind` may be omitted on a repo entry and defaults to `'repo'`.

A hub entry promises a hub folder at `path`. Pimote materializes it on the first open when the directory is absent: one absolute symlink per member, a generated `AGENTS.md` that lists the members as prose, a `.gitignore`, and `git init`. A source hub is always the symlink layout, never the worktree layout, and its `AGENTS.md` carries no managed member block. `memberPaths` may point at folders that do not exist yet.

## RepoInfo

```ts
interface RepoInfo {
  path: string;
  name: string;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  worktreePath?: string;
  lastActivity?: number;
  missing?: boolean;
  tags?: string[];
}
```

`path` is the folder identity. Use the canonical real path, because sessions, curation, and hub membership all key on it. A symlinked path yields a row whose identity differs from the target's.

Pimote owns the facts it can observe:

| Field                                | Owner                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `branch`, `dirty`, `ahead`, `behind` | Pimote probes these for a path that exists and replaces your values.                                          |
| `tags`, `lastActivity`               | Merged into the scanned row.                                                                                  |
| `missing`                            | Yours. `true` on an existing path suppresses status probing.                                                  |
| `worktreePath`                       | Yours, for a checkout inside a hub, so repo facts describe the nested checkout while `path` stays the source. |

A source entry whose path classifies as a persona home appears as a persona row, not a repo row. Duplicate hub paths keep the first source, and Pimote filters identities it excludes, such as the manager root.

Source tags are visible to the user and not removable from the dashboard.

## Open hooks

Pimote awaits `onFolderOpen` before it opens anything from a listed entry:

- A row click or an explicit open.
- A new session in that folder.
- An open through the manager.

For a promised hub, Pimote materializes the folder first, then runs the hooks.

Hooks run in source registration order, and the first throw aborts the open. Filter by path inside the hook:

```ts
async onFolderOpen(folderPath) {
  if (!isMine(folderPath)) return;
  await shellCloneIfMissing(folderPath);
}
```

Because the hook runs before every open and not only the first, keep it cheap and repeatable.

## What a source cannot do

- Create, rename, or delete folders. Pimote core owns creation.
- Set curation. Favorites, archive state, and editability belong to the user.
- Make a folder visible outside the listing. A session starts in a listed folder, and the manager resolves folders by canonical path.
- Extend the hub model. A source hub is one layout, and membership edits belong to Pimote core.

## Example

```ts
const source: FolderSource = {
  id: 'team-repos',
  async list() {
    const repos = await readTeamIndex();
    return [
      ...repos.map((repo) => ({
        kind: 'repo' as const,
        path: repo.path,
        name: repo.name,
        branch: repo.branch,
        dirty: false,
        ahead: 0,
        behind: 0,
      })),
      {
        kind: 'hub',
        path: '/srv/team/workspace',
        name: 'workspace',
        memberPaths: repos.map((repo) => repo.path),
      },
    ];
  },
  async onFolderOpen(folderPath) {
    if (folderPath === '/srv/team/workspace') await ensureTeamCheckouts();
  },
};
```

## Freshness

The listing holds for 30 seconds and serves stale rows while a background refresh runs, so `list` runs on that cadence and after invalidation, not per request. A refresh that changes a row broadcasts it to connected clients.

A cold read waits for your `list`. Keep a network fetch inside it bounded, or an unreachable service delays the whole listing.
