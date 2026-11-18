# Hubs

A hub is an included folder whose members appear inside it. Membership is the on-disk shape, whoever created the folder. This page describes both member layouts, the membership tools, and disband. Read `folders.md` first for the walk and the folder identity.

A hub classifies as code or persona by its own marker, like any folder. It is a working folder, not a shell. A code hub can hold hub-level code. A persona hub is an agent with its own prompt and `memory.md`.

## Member layouts

A row reports the layout as `hub.representation`.

| Layout     | Code member                  | Persona member | Marker             |
| ---------- | ---------------------------- | -------------- | ------------------ |
| `symlink`  | Absolute symlink in the hub  | Symlink        | none               |
| `worktree` | Nested detached Git worktree | Symlink        | `.pimote-hub.json` |

### Symlink layout

```text
/srv/repos/
├── platform/                  code hub
│   ├── AGENTS.md              generated, with the managed member block
│   ├── .gitignore             one /<member> line per member
│   ├── api    -> /srv/repos/api
│   └── web    -> /srv/repos/web
├── api/                       canonical home
└── web/                       canonical home
```

Pimote writes the symlinks, the `AGENTS.md`, and the `.gitignore`, then runs `git init`. Members keep their canonical homes. The `.gitignore` holds one root-anchored literal pattern per member basename, so the links stay untracked.

### Worktree layout

```text
/srv/repos/
├── platform/                        code hub, worktree mode
│   ├── AGENTS.md                    generated, with the managed member block
│   ├── .pimote-hub.json             {"memberRepresentation":"worktree"}
│   ├── .gitignore                   marker line plus one /<member> line each
│   ├── api/                         detached worktree of /srv/repos/api
│   └── web/                         detached worktree of /srv/repos/web
├── api/                             canonical home
└── web/                             canonical home
```

Pimote runs `git worktree add --detach <hub>/<name> HEAD` for each code member. Each checkout starts detached at its source `HEAD`.

Pimote never creates, names, attaches, merges, commits, stashes, or deletes branches. The user or an agent owns branch work.

Persona members stay symlinks in both layouts.

The `.pimote-hub.json` marker preserves worktree mode after the last code worktree leaves, so later additions detach again. Pimote accepts the marker when the parsed value equals `{"memberRepresentation":"worktree"}` and rejects it when any other key or value appears. A verified nested worktree also proves worktree mode without the marker.

Identity stays canonical in both layouts. A member's `path` is the source checkout Git reports and `worktreePath` is the nested checkout. Repo facts (`branch`, `dirty`, `ahead`, `behind`) describe the nested checkout. Tags and membership identity resolve from the source.

## Managed member block

A registry-created hub carries one generated block in `AGENTS.md`:

```text
<!-- pimote:members (managed block) -->
- api (code): read nested AGENTS.md for context.
- ada (persona): always spin a sub-agent in this folder to interact with it.
<!-- /pimote:members -->
```

`pimote_update_hub_members` owns these exact seeded lines and nothing else. It inserts one line per member and deletes only byte-exact matches. Every other byte of the file stays as it is.

A hub whose markers are gone gets a fresh block appended on the next add. Do not hand-edit inside the block. Disband rejects a block that lacks the seeded line of a current member.

## Create a hub

`pimote_create_folder` with kind `code-hub` or `persona-hub` builds a hub in one of the two layouts.

- Members must be known folders with a canonical path, unique basenames, and no containment with the hub, in either direction.
- `memberRepresentation: "worktree"` selects the worktree layout for code members. Omit it for symlinks.
- `description` is required for a persona hub. `prompt` becomes its persona text with no shipped template added.
- A persona hub also writes `memory.md`.
- A failed build removes every worktree and the hub directory before it reports the error.

A source-registered hub can be promised before its folder exists, and Pimote materializes the symlink layout on first open. Such a hub is never a worktree hub, and its `AGENTS.md` lists members as prose without a managed block. Adding a member appends a block next to that prose.

## Change membership

`pimote_update_hub_members` takes `hubPath`, `add`, and `remove`. Removals run before additions, and each member reports its own outcome:

```text
pimote_update_hub_members { hubPath: "/srv/repos/platform", remove: ["/srv/repos/old-api"], add: ["/srv/repos/api"] }
```

```json
{
  "results": [
    { "memberPath": "/srv/repos/old-api", "action": "remove", "outcome": "removed" },
    { "memberPath": "/srv/repos/api", "action": "add", "outcome": "added" }
  ]
}
```

The layout decides the edit:

- A code member added to a worktree hub detaches at its source `HEAD`. In a symlink hub it joins by symlink.
- A persona member always joins by symlink.
- Removing a worktree member requires a clean checkout and runs `git worktree remove` without `--force`.
- Removing a symlink member unlinks the link and never touches the target.

A member edit updates the shape, the managed line, and the existing `.gitignore`. It never writes to a member directory or a source repository. A failure rolls back the partial edit and reports which member failed.

These errors stop one member and leave the batch running:

| Error                                                        | Cause                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `Unknown hub folder: <path>`                                 | The hub is not a listed folder, or its row is `missing`. |
| `Not a hub folder: <path>`                                   | The folder has no members and no marker.                 |
| `A hub cannot be its own member: <path>`                     | The member path is the hub.                              |
| `A hub member cannot contain or live inside the hub: <path>` | Either path contains the other.                          |
| `Unknown folder: <path>`                                     | The member is not a discovered folder.                   |
| `Unknown or excluded worktree source: <path>`                | A worktree hub rejected the source checkout.             |
| `Reserved member name: AGENTS.md`                            | The member basename collides with the generated file.    |
| `Duplicate member name: <name>`                              | Another entry already holds that name in the hub.        |
| `Worktree source identity is ambiguous for <path>`           | Several checkouts match the source basename.             |
| `Worktree has uncommitted changes: <checkout>`               | A removal found a dirty checkout.                        |
| `Not a member of <hub basename>: <path>`                     | The removal path does not match any member.              |

## Disband a worktree hub

`pimote_disband_hub` removes every nested worktree through Git and deletes the hub directory. It merges, commits, stashes, and deletes nothing.

```text
pimote_disband_hub { hubPath: "/srv/repos/platform" }
```

The tool requires a listed hub row plus a valid `.pimote-hub.json` marker. A verified nested worktree alone does not authorize deletion, and a symlink hub never qualifies. Delete a symlink hub by hand like any other folder.

The guards run in this order. The first failure leaves the hub and its remaining members on disk.

1. **Use.** Pimote first closes idle sessions with no observers in the hub and in every checkout, the way archiving retires a session. It then rejects any remaining session or external pi process: `Hub is in use by an active session or pi process: <paths>`.
2. **Content.** Every child must be generated content, a member symlink, or a verified member checkout. A file or directory that Git cannot vouch for stops the run: `Unrecognized content in the hub: <path>`.
3. **Generated files.** `AGENTS.md`, `.gitignore`, `memory.md`, `.pimote-hub.json`, and `.git` must keep their expected type and content. Disband rejects an edited `memory.md`, a missing seeded member line, or a `.gitignore` that differs from the generated set.
4. **Hub repository.** The hub repository must be clean: `The hub repository has uncommitted changes: <path>`.
5. **Checkouts.** Every checkout must be clean before any removal starts: `Worktree has uncommitted changes: <checkout>`. Every detached `HEAD` must also be reachable from a local or remote-tracking branch ref: `Detached HEAD in <checkout> is not reachable from a branch ref; create a branch to keep the work.`

Generated content is protected even when Git ignores it. Pimote stores a baseline of the generated files and compares against it, so a stale generated file blocks the run like an edited one.

On success the result lists the removed checkout paths in `removedWorktreePaths`. Source repositories, their branches, and persona member targets stay untouched.

Some guards can close a session before a later guard rejects the run. Read the hub again before you retry.
