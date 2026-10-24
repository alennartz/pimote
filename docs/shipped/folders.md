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

An included folder, code or persona, yields exactly one occurrence. The walk never descends into its real subfolders. They are invisible to the model, whatever markers they carry. The only children the walk takes from an included folder are its top-level symlinks whose targets lie outside it. Each becomes a shortcut occurrence, and discovery restarts at the target. This is why hub members are symlinked into hubs, and why a persona hub works exactly like a code hub.

## Creation placement

Select an existing scan root or skipped folder within one as the parent.
Use only skipped folders that discovery traverses, not pruned directories.
Keep the parent outside included folders and their descendants.
Otherwise, discovery cannot reach the new folder.

Read the configured scan roots, then inspect candidate skipped folders on disk.
Use `pimote_find_folders` to select member homes, not parent locations.
Its rows represent included folders, where real subfolders remain undiscovered.

## Hubs

A hub is any included folder whose top-level symlinks point to discovered folders outside it. The symlink inventory is the membership truth, whoever created the folder.

`pimote_create_folder` builds the standard shape: absolute symlinks, a generated `AGENTS.md` with a managed member block, `git init`, and a `.gitignore` that lists member names. A hub is a working folder, not a shell. Code hubs can carry hub-level code. Persona hubs are agents with their own prompt and `memory.md`. Hubs classify as code or persona by their own marker.

Source-listed hubs can be promised before their folder exists. Once materialized, the same on-disk shape takes over.

## Curation

Favorite, archived, and tags attach to the canonical path. A folder moved on disk orphans its curation state. The state stays recorded and is ignored. Restore an archived folder with `pimote_update_folder` (`archived: false`). The folder never leaves disk.

## Freshness

One cached walk feeds the folder listing and its repo facts. The cache holds for 30 seconds and serves stale entries while a background refresh runs. Consequences:

- After a manual `mv` or `ln`, wait for cache expiry, then search again before treating a missing folder as a failure. A read can trigger a background refresh, so search again after that refresh completes.
- Creation and membership tools invalidate discovery and broadcast folder changes. Curation broadcasts updated rows without a filesystem refresh.

## Sessions

Sessions persist per folder. Personas run rooted in their own folder. Any discovered folder accepts a new session through `pimote_start_session`. Folders the model cannot see, such as those nested inside an included folder, accept none.
