# Topology recipes

Recipes for the four folder kinds, each created with `pimote_create_folder`.
Select an existing scan root or skipped folder within one as the parent.
Keep it outside included folders and their descendants, where discovery stops.
Use `pimote_find_folders` to select canonical member homes, not parent locations.
See `folders.md` for placement and discovery rules.

## Code folder

```
pimote_create_folder { kind: "code", name: "app", parentPath: "/srv/repos", body: "What this repo is for." }
```

Creates `app/` with `git init` and a seeded `AGENTS.md`. Discovery follows from the `.git` marker.

## Persona folder

```
pimote_create_folder { kind: "persona", name: "ada", parentPath: "/srv/repos", description: "debugging specialist", prompt: "You are Ada." }
```

Creates `ada/` with a persona-marker `AGENTS.md` and a `memory.md` stub.
The caller prompt precedes the shipped persona template and its memory-maintenance instruction.
Sessions run in this folder.

## Code hub

```
pimote_create_folder { kind: "code-hub", name: "platform", parentPath: "/srv/repos", memberPaths: ["/srv/repos/api", "/srv/repos/web"] }
```

Creates `platform/` with symlinks to `api` and `web`, a generated `AGENTS.md` with the managed member block, `git init`, and a member `.gitignore`. Members keep their canonical homes and appear at top level too.

Add `memberRepresentation: "worktree"` to hold code members as nested detached worktrees instead of symlinks:

```
pimote_create_folder { kind: "code-hub", name: "platform", parentPath: "/srv/repos", memberPaths: ["/srv/repos/api", "/srv/repos/web"], memberRepresentation: "worktree" }
```

Each code member becomes a detached checkout at its source `HEAD` (`platform/api`, `platform/web`). The source repositories and their branches stay untouched. Pimote performs no branch operations; the user or an agent owns branch work. The hub writes `.pimote-hub.json` to preserve worktree mode, and the `.gitignore` ignores member names and the marker.

## Persona hub

```
pimote_create_folder { kind: "persona-hub", name: "danny", parentPath: "/srv/repos", description: "crew lead", prompt: "You are Danny Ocean.", memberPaths: ["/srv/repos/rusty", "/srv/repos/livingston"] }
```

The hub itself is a persona, with a persona marker and a `memory.md` stub.
Unlike a plain persona folder, it uses the caller prompt directly before the hub text and managed member block.
It does not add the shipped persona template.
The remaining structure matches a code hub. Pass `memberRepresentation: "worktree"` to detach code members; persona members always stay symlinks either way.
The expected listing has one hub row with two members, plus one row per member.

```
/srv/repos/
├── danny/                  persona (the hub)
│   ├── AGENTS.md           marker + managed member block
│   ├── memory.md
│   ├── rusty      -> /srv/repos/rusty        (shortcut)
│   └── livingston -> /srv/repos/livingston   (shortcut)
├── rusty/                  persona (canonical home)
└── livingston/             persona (canonical home)
```

Sessions can start at any of the three folders. Change membership later through `pimote_update_hub_members`. Never hand-edit inside the managed member block of a hub `AGENTS.md`, which is the lines between `<!-- pimote:members (managed block) -->` and `<!-- /pimote:members -->`.

## Worktree hub lifecycle

A worktree hub's members live as nested detached checkouts:

```
/srv/repos/
├── platform/                 code hub (worktree mode)
│   ├── AGENTS.md             managed member block
│   ├── .pimote-hub.json      {"memberRepresentation":"worktree"}
│   ├── .gitignore
│   ├── api/                  detached worktree of /srv/repos/api
│   └── web/                  detached worktree of /srv/repos/web
├── api/                      canonical home
└── web/                      canonical home
```

`pimote_update_hub_members` follows the hub's mode: a new code member detaches at its source `HEAD`; a new persona member symlinks. Removing a worktree member requires a clean checkout and removes only the nested checkout. The canonical home keeps its branch and history.

A finished worktree hub is disbanded, not hand-deleted:

```
pimote_disband_hub { hubPath: "/srv/repos/platform" }
```

Disband removes every nested worktree through Git, then deletes the hub directory. It refuses the hub while a session or external pi process sits in it, while a checkout is dirty, or while a detached `HEAD` is unreachable from a local or remote-tracking branch ref. It keeps the hub on disk in every refusal, so a fix and a retry cost nothing. Symlink hubs reject disband.

## Global Pimote extension

Place a module in `$XDG_CONFIG_HOME/pimote/extensions/`:

```ts
import type { PimoteExtension } from '@pimote/sdk/pimote';

export default ((context) => {
  context.folders.registerSource({ id: 'team-folders', list: async () => [] });
  context.settings.registerFile('./team-instructions.md');
  context.on('shutdown', () => {});
}) satisfies PimoteExtension;
```

The host loads the module at startup and on server-wide `/reload`. Relative Settings paths use the module directory. User-installed packages can declare `pimote.extensions`; Pi-only and project-scoped package entries stay outside this host. A failed module produces a diagnostic but does not discard valid registrations.

## Anti-patterns and their symptoms

| Attempt                                                               | Symptom                                                                                                                          | Fix                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Nest a real persona folder inside another persona folder.             | Parent shows no children. The nested folder never registers. No session can start in it.                                         | Move the member back to its canonical home at top level, then link it with `pimote_update_hub_members` and `add`. |
| Build a hub by hand with symlinks and custom `AGENTS.md` prose.       | Membership tools work from the symlink shape. Custom member lines do not match the seeded strings and stay untouched on removal. | Use `pimote_update_hub_members`. It edits only exact seeded lines and adds a managed block for later edits.       |
| Manual `mv` of a folder, then an immediate read.                      | Cached listings lag. Curation remains at the old canonical path.                                                                 | Wait for cache expiry, then search again. Reapply curation at the new path.                                       |
| Hand-edit the managed member block.                                   | Membership tools and the block drift apart.                                                                                      | Use `pimote_update_hub_members`. Edits outside the block markers stay yours.                                      |
| Remove a worktree member or disband the hub with uncommitted changes. | Rejection: `Worktree has uncommitted changes`. The hub stays untouched.                                                          | Commit or clean the checkout, then retry.                                                                         |
| Disband a hub whose worktree holds unreachable detached work.         | Rejection: the detached `HEAD` is not reachable from a branch ref.                                                               | Create a branch (local or pushed) so a ref holds the commit, then disband.                                        |
| Disband while a session or pi process works in the hub.               | Rejection: the hub is in use.                                                                                                    | Close the session and wait for external pi processes to leave, then retry.                                        |
