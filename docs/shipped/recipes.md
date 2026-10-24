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

## Persona hub

```
pimote_create_folder { kind: "persona-hub", name: "danny", parentPath: "/srv/repos", description: "crew lead", prompt: "You are Danny Ocean.", memberPaths: ["/srv/repos/rusty", "/srv/repos/livingston"] }
```

The hub itself is a persona, with a persona marker and a `memory.md` stub.
Unlike a plain persona folder, it uses the caller prompt directly before the hub text and managed member block.
It does not add the shipped persona template.
The remaining structure matches a code hub.
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

## Anti-patterns and their symptoms

| Attempt                                                         | Symptom                                                                                                                          | Fix                                                                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Nest a real persona folder inside another persona folder.       | Parent shows no children. The nested folder never registers. No session can start in it.                                         | Move the member back to its canonical home at top level, then link it with `pimote_update_hub_members` and `add`. |
| Build a hub by hand with symlinks and custom `AGENTS.md` prose. | Membership tools work from the symlink shape. Custom member lines do not match the seeded strings and stay untouched on removal. | Use `pimote_update_hub_members`. It edits only exact seeded lines and adds a managed block for later edits.       |
| Manual `mv` of a folder, then an immediate read.                | Cached listings lag. Curation remains at the old canonical path.                                                                 | Wait for cache expiry, then search again. Reapply curation at the new path.                                       |
| Hand-edit the managed member block.                             | Membership tools and the block drift apart.                                                                                      | Use `pimote_update_hub_members`. Edits outside the block markers stay yours.                                      |
