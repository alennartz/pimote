# Folder model

Pimote discovers folders under configured scan roots and shows what it finds as one flat listing. This page describes the walk, the folder identity, and the rules that decide whether a folder appears. Read it before you create, move, or curate a folder.

`hubs.md` covers hub shapes. `recipes.md` covers creation examples. `tools.md` covers the tool parameters.

## Scan roots

Discovery starts at `roots` in the native config and nowhere else. Each root canonicalizes first, and a root that fails to resolve is skipped with a server warning.

The walk has no depth bound. It has one budget: 50,000 folder visits per scan. A scan that exceeds the budget serves a partial tree and writes one warning to the server log. Tool callers see missing rows, not an error.

The manager root yields no row. Pimote removes it from every listing, so no tool can open or create a session there.

## Skipped and included folders

Each folder is classified when the walk reaches it.

A folder is **included** when it carries a marker:

- A persona marker: `AGENTS.md` opens with a YAML front-matter block whose `kind` is `persona`.
- A code marker: a `.git` entry. A file or a directory both qualify.

An included folder appears in the listing. Every other folder is **skipped**: it never appears, and the walk descends through it.

Pruned names stop descent through skipped folders:

```text
node_modules  .git  dist  build  target  .venv
```

The prune test runs before classification, so a skipped folder named `dist` is never visited. A pruned name never disqualifies a shortcut or an included folder.

A walk drops a child that is not a directory or a symlink to a directory. A dangling or looping symlink reaches the walk as a skipped folder with no children.

## Persona marker

A persona marker is a front-matter block at the top of `AGENTS.md`:

```markdown
---
kind: persona
name: ada
description: debugging specialist
---

You are Ada. Read `memory.md` first.
```

These conditions all hold before the marker counts:

- The first line trims to `---`.
- A later line matches `---` at column 0.
- The block parses as a YAML mapping.
- `kind` is the bare string `persona`.

`name` and `description` are optional strings. The `AGENTS.md` body is the persona prompt.

A marker wins over git. A git-initialized persona folder is a persona. An unreadable `AGENTS.md` counts as no marker and falls back to `.git`, with a server warning.

## Leaves and shortcuts

An included folder is a leaf. The walk never reads its real subdirectories, whatever markers they carry. Those folders stay invisible to the model, and no session can start in them.

The walk takes one kind of child from an included folder: a top-level symlink whose target is a directory outside the folder. Each becomes a **shortcut occurrence**, and discovery restarts at the target. This is how symlink hub members enter the listing.

A worktree hub's nested checkouts are real directories inside an included folder. The walk never reaches them. The hub probe reports them as members instead. See `hubs.md`.

## Identity and occurrences

A folder's identity is its canonical real path, reported as `path`.

An **occurrence** is one reach path: a walked scan path, or a shortcut path. One folder reached several ways yields several occurrences that share one identity. A shortcut occurrence nests the target's own discoveries under `children`.

Sessions, curation, and membership all key on `path`. A symlinked path is a reach path, not an identity.

A row reports `name` as the folder basename. A persona's display name lives in `persona.name`.

## Listing rules for hubs

A hub is an included folder whose members appear as symlinks or verified nested Git worktrees. `hubs.md` defines each shape.

One listing consequence belongs here. A symlink counts as a member only when its target is a known folder. An `ln -s` into a hub that points at an undiscovered directory creates a shortcut for the walk but no member. Add members with `pimote_update_hub_members`.

## Missing folders

A source-listed folder yields a row with `missing: true` while its directory is absent. A folder that vanishes from disk keeps a row the same way, with its curation state intact.

A missing row appears in `pimote_find_folders` and accepts no new session.

## Curation

Favorite, archived, and tags attach to the canonical path and persist in `registry.json` under the Pimote state directory.

- `favorite` sorts a folder first in the listing.
- `archived` hides it from listings that do not ask for archived rows. The directory never moves or leaves disk. Restore it with `pimote_update_folder {archived: false}`.
- `tags` reports the union of source tags, inherited member tags, and user tags.
- `userTags` reports the tags set on this path alone. `removeTags` deletes from this set.

An inherited tag cannot be removed at the hub path. The call succeeds and the tag stays.

A folder moved on disk orphans its curation state. The state stays recorded and stops matching any row. Move curation by setting it again at the new path.

Curation edits never invalidate discovery, because they change no filesystem shape.

## Freshness

Two caches sit between disk and the tools. Both hold for 30 seconds and serve stale data while a background refresh runs.

- **Discovery** caches the walk and the git facts of each folder. A cold cache blocks the first read. A warm read returns at once and starts a probe.
- **Session metadata** caches `lastActivity` and the search text taken from session records.

Manager reads serve warm git facts only. A folder row can arrive with `branch: null`, `dirty: false`, and zero `ahead` and `behind` while its probe runs. Pimote sends the facts later on the folder delta channel. Read again before you treat a row as clean.

A background refresh that finds a change broadcasts it. Two tool calls inside one 30-second window can therefore disagree.

Invalidation is immediate in the cache that owns the data:

- Discovery: folder and hub creation through Pimote, hub membership edits, hub disband, an `AGENTS.md` save from the Settings tab, and an extension reload.
- Session metadata: a session that opens, changes status, or closes, a folder rename, delete, or archive from the dashboard, and a manager archive or resume.

A curation edit invalidates neither cache. It changes no filesystem shape, so it only broadcasts the new row.

After a manual `mv`, `rm`, or `ln`, wait for cache expiry and search again. One search can still miss a folder whose refresh has not finished.

## Sessions

Sessions persist per folder and key on the canonical path. `sessions.md` describes which folders host sessions and what the manager root changes.
