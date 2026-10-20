# Topology recipes

Recipes for the four folder kinds. All four are one `pimote_create_folder` call. `parentPath` must sit inside a scan root. Pick parent and members with `pimote_find_folders`, where hub rows carry `members`.

## Code folder

```
pimote_create_folder { kind: "code", name: "app", parentPath: "/srv/repos", body: "What this repo is for." }
```

Creates `app/` with `git init` and a seeded `AGENTS.md`. Discovery follows from the `.git` marker.

## Persona folder

```
pimote_create_folder { kind: "persona", name: "ada", parentPath: "/srv/repos", description: "debugging specialist", prompt: "You are Ada." }
```

Creates `ada/` with a persona-marker `AGENTS.md`. The description is required, and the prompt folds into the shipped template. Also creates a `memory.md` stub. The persona runs sessions rooted in this folder.

## Code hub

```
pimote_create_folder { kind: "code-hub", name: "platform", parentPath: "/srv/repos", memberPaths: ["/srv/repos/api", "/srv/repos/web"] }
```

Creates `platform/` with symlinks to `api` and `web`, a generated `AGENTS.md` with the managed member block, `git init`, and a member `.gitignore`. Members keep their canonical homes and appear at top level too.

## Persona hub

```
pimote_create_folder { kind: "persona-hub", name: "danny", parentPath: "/srv/repos", description: "crew lead", prompt: "You are Danny Ocean.", memberPaths: ["/srv/repos/rusty", "/srv/repos/livingston"] }
```

Same as the code hub, plus the persona marker and a `memory.md` stub. The hub itself is a persona. Expected folder shape, as `pimote_find_folders` reports it: one hub row with two members, plus one row per member.

```
/srv/repos/
├── danny/                  persona (the hub)
│   ├── AGENTS.md           marker + managed member block
│   ├── memory.md
│   ├── rusty      -> ../rusty        (shortcut)
│   └── livingston -> ../livingston   (shortcut)
├── rusty/                  persona (canonical home)
└── livingston/             persona (canonical home)
```

Sessions can start at any of the three folders. Change membership later through `pimote_update_hub_members`. Never hand-edit inside the managed member block of a hub `AGENTS.md`, which is the lines between `<!-- pimote:members (managed block) -->` and `<!-- /pimote:members -->`.

## Anti-patterns and their symptoms

| Attempt                                                         | Symptom                                                                                                                          | Fix                                                                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Nest a real persona folder inside another persona folder.       | Parent shows no children. The nested folder never registers. No session can start in it.                                         | Move the member back to its canonical home at top level, then link it with `pimote_update_hub_members` and `add`. |
| Build a hub by hand with symlinks and custom `AGENTS.md` prose. | Membership tools work from the symlink shape. Custom member lines do not match the seeded strings and stay untouched on removal. | Use `pimote_update_hub_members`. It edits only exact seeded lines and adds a managed block for later edits.       |
| Manual `mv` of a folder, then an immediate read.                | Stale rows, missing rows, or orphaned curation for up to about 30 seconds.                                                       | Re-read with `fresh: true`. Expect curation loss after a real move.                                               |
| Hand-edit the managed member block.                             | Membership tools and the block drift apart.                                                                                      | Use `pimote_update_hub_members`. Edits outside the block markers stay yours.                                      |
