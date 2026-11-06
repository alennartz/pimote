# Folder model

Describes how pimote finds, classifies, and identifies folders. Read it before you change folder structure, hub membership, or curation.

## Scan roots and the walk

Discovery starts at the configured scan roots. It never starts at the manager root, and the manager root is excluded from every listing. The walk descends through skipped folders with no depth bound. It stops at included folders.

Pruned names (`node_modules`, `.git`, `dist`, `build`, `target`, `.venv`) stop descent through skipped folders. They never disqualify a shortcut.

## Nature detection

A folder is a persona folder when its `AGENTS.md` begins with a YAML front-matter block that carries `kind: persona`. Its `name` and `description` fields are optional strings. The `AGENTS.md` body is the persona prompt.

Otherwise, a folder is a code folder when it has `.git`. Otherwise, it is skipped structure that the walk descends through. The marker wins over git: a git-initialized persona folder is a persona.

## Entries, occurrences, identity

Identity is the canonical real path (`entry.path`). An occurrence is one reach path: the walked scan path or a symlink shortcut path, with skipped segments collapsed inline. One folder reached several ways yields several occurrences that share one entry. Shortcut occurrences nest the target's own discoveries in `children`. Treat `entry.path` as the only identity. Sessions, curation, and membership key on it.

## The leaf and shortcut rule

An included folder, code or persona, yields exactly one occurrence. The walk never descends into its real subfolders. They are invisible to the model, whatever markers they carry. The only children the walk takes from an included folder are its top-level symlinks whose targets lie outside it. Each becomes a shortcut occurrence, and discovery restarts at the target. This is why hub members are symlinked into hubs, and why a persona hub works exactly like a code hub. A worktree hub's nested checkouts are real directories inside an included folder, so the walk never reaches them; the registry's hub probe recognizes them (see Hubs).

## Creation placement

Select an existing scan root or skipped folder within one as the parent.
Use only skipped folders that discovery traverses, not pruned directories.
Keep the parent outside included folders and their descendants.
Otherwise, discovery cannot reach the new folder.

Read the configured scan roots, then inspect candidate skipped folders on disk.
Use `pimote_find_folders` to select member homes, not parent locations.
Its rows represent included folders, where real subfolders remain undiscovered.

## Hubs

A hub is any included folder whose top-level members point to discovered folders outside it. Membership is the on-disk shape, whoever created the folder. A member is a top-level symlink or a verified nested Git worktree. The hub probe recognizes a nested worktree when the child carries a `.git` file and `git worktree list --porcelain` confirms the checkout. Ordinary nested directories and independent repositories are not members.

`pimote_create_folder` builds the standard shape: absolute symlinks, a generated `AGENTS.md` with a managed member block, `git init`, and a `.gitignore` that lists member names. A hub is a working folder, not a shell. Code hubs can carry hub-level code. Persona hubs are agents with their own prompt and `memory.md`. Hubs classify as code or persona by their own marker.

The hub fact on a folder row reports the member representation: `symlink` (default) or `worktree`. `shortcutCount` counts symlink members only. Worktree members are real directories, not shortcuts.

Source-listed hubs can be promised before their folder exists. Once materialized, the same on-disk shape takes over.

## Worktree hubs

Set `memberRepresentation: "worktree"` on creation to hold code members as nested detached Git worktrees instead of symlinks. The hub writes `.pimote-hub.json` containing exactly `{"memberRepresentation":"worktree"}`. The marker preserves worktree mode after the last code worktree is removed, so later additions detach again. A valid nested worktree proves worktree mode without the marker. Persona members always stay symlinks.

Creation runs `git worktree add --detach <hub-child> HEAD` in each code member. The checkout starts detached at the source's current `HEAD`. Pimote never creates, names, attaches, merges, commits, stashes, or deletes branches. The user or an agent owns branch work. A failed creation removes the worktrees it already made before removing the fresh hub directory.

Member identity stays canonical: a worktree member's `path` is the source checkout Git reports, and `worktreePath` is the nested checkout inside the hub. Repo facts (branch, dirty, ahead, behind) describe the nested checkout. Tags and membership identity resolve from the source.

Membership edits follow the hub's mode. Adding a code member to a worktree hub detaches it from its current `HEAD`; adding a persona symlinks it. A failure after Git created a worktree removes that worktree before the error reports. Removing a worktree member requires a clean checkout (`git status --porcelain` empty). Removal runs `git worktree remove` and never touches the source repository or its branches.

## Disbanding a worktree hub

Disband removes every nested worktree through Git, then deletes the hub directory. Only a marked or Git-verified worktree hub accepts it. Symlink hubs reject disband; delete them by hand like any other folder. The guards run before any mutation:

- Idle sessions with no observers in the hub or any checkout are closed first, through the same lifecycle the idle reaper uses. Disband retires hub sessions the way archiving does. Sessions that are still working or observed keep the hub. The check fails closed when an activity source fails.
- Every checkout must be clean.
- Every detached `HEAD` must be reachable from a local or remote-tracking branch ref. Unreachable work blocks disband. Create a branch to keep it.

Every worktree is validated before any is removed. A failure leaves the hub and its remaining shape discoverable for a retry. Disband never follows member symlinks, so persona links unlink with the hub directory.

## Curation

Favorite, archived, and tags attach to the canonical path. A folder moved on disk orphans its curation state. The state stays recorded and is ignored. Restore an archived folder with `pimote_update_folder` (`archived: false`). The folder never leaves disk.

## Pimote extension host

Process-global Pimote extensions load from `$XDG_CONFIG_HOME/pimote/extensions/` in deterministic order. The host accepts direct JavaScript or TypeScript modules and extension directories with an entry file. User-scoped Pi packages can contribute entries through `pimote.extensions`; project packages and `pi.extensions` entries are ignored. Each module exports a default `PimoteExtension` factory from `@pimote/sdk/pimote`.

A factory receives `folders.registerSource(source)`, `settings.registerFile(path)`, and `on('shutdown', handler)`. Relative Settings paths resolve from the entry module. Reload awaits shutdown, invalidates old registrations, clears the loader cache, and replaces the registry even when one entry fails. Folder creation remains a core dashboard and manager operation, not an extension registration.

## Global Settings files

The Settings manifest combines effective Pi `AGENTS.md`, effective Pi `settings.json`, native Pimote config, `settingsFiles` entries, and extension registrations. The server resolves these paths and labels. The client never reconstructs host paths. A missing entry remains visible and is created by a successful save. Native Pimote config writes are parsed and validated before an atomic write. `tagSnippets` is validated on the server and advertised in `server_capabilities`.

Native configuration changes follow this matrix. `settingsFiles` and `tagSnippets` apply immediately. Default provider, model, thinking, interpreter-model, and worker-model fields apply to new sessions or new voice extensions. `idleTimeout` is read at the next idle check. `bufferSize` applies to new session buffers. `roots`, `managerRoot`, `port`, VAPID keys, and active voice transport are startup-only. Pi-native and third-party files have no Pimote reload policy. The manifest stays fixed while its dialog is open; changed file lists appear on the next opening.

## Freshness

One cached walk feeds the folder listing and its repo facts. The cache holds for 30 seconds and serves stale entries while a background refresh runs. Consequences:

- After a manual `mv` or `ln`, wait for cache expiry, then search again before treating a missing folder as a failure. A read can trigger a background refresh, so search again after that refresh completes.
- Creation and membership tools invalidate discovery and broadcast folder changes. Curation broadcasts updated rows without a filesystem refresh.

## Sessions

Sessions persist per folder. Personas run rooted in their own folder. Any discovered folder accepts a new session through `pimote_start_session`. Folders the model cannot see, such as those nested inside an included folder, accept none.
