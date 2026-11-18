# Topology recipes

Four folder kinds exist, and `pimote_create_folder` builds each one. This page gives a worked call for each kind and the failures that follow from a wrong shape.

Read `folders.md` for the walk and the identity, and `hubs.md` for membership and disband.

## Select the parent

The parent must be an existing scan root, or a skipped folder inside one. Keep it outside every included folder and its descendants, because the walk treats an included folder as a leaf.

`parentPath` is checked against the scan roots only. A parent inside an included folder, or inside a pruned directory, succeeds and returns a path that discovery never shows.

Use `pimote_find_folders` to select member homes. Its rows are included folders, and a real subfolder of a row is not a candidate for either job.

## Code folder

```text
pimote_create_folder { kind: "code", name: "app", parentPath: "/srv/repos", body: "What this repo is for." }
```

Creates `app/` with a seeded `AGENTS.md` and runs `git init`. The `.git` entry is what makes discovery include the folder.

## Persona folder

```text
pimote_create_folder { kind: "persona", name: "ada", parentPath: "/srv/repos", description: "debugging specialist", prompt: "You are Ada." }
```

Creates `ada/` with a persona marker, a `memory.md` stub, and no `git init`.

```text
---
kind: persona
name: "ada"
description: "debugging specialist"
---

You are Ada.

You are a persona agent. This folder is your identity and home.
```

`description` is required. The `prompt` text precedes the shipped persona template, and the file continues with its memory-maintenance instruction. Sessions run rooted in this folder.

## Code hub

```text
pimote_create_folder { kind: "code-hub", name: "platform", parentPath: "/srv/repos", memberPaths: ["/srv/repos/api", "/srv/repos/web"] }
```

Creates `platform/` with one absolute symlink per member, a generated `AGENTS.md` with the managed member block, a `.gitignore` with one `/<member>` line each, and `git init`.

```text
/srv/repos/
├── platform/                 code hub
│   ├── AGENTS.md             generated, with the managed member block
│   ├── .gitignore
│   ├── api -> /srv/repos/api
│   └── web -> /srv/repos/web
├── api/
└── web/
```

Members keep their canonical homes and also appear at the top level of the listing.

Every member must be a known folder, with a unique basename, and with no containment between it and the hub in either direction. Pass canonical absolute paths. Pimote stores the string you pass as the link target.

## Persona hub

```text
pimote_create_folder { kind: "persona-hub", name: "danny", parentPath: "/srv/repos", description: "crew lead", prompt: "You are Danny Ocean.", memberPaths: ["/srv/repos/rusty", "/srv/repos/livingston"] }
```

The hub itself is a persona. It carries a persona marker, the `prompt` text as its persona text, the generated member block, a `memory.md` stub, `.gitignore`, and `git init`.

```text
/srv/repos/
├── danny/                    persona (the hub)
│   ├── AGENTS.md             marker, intro, managed member block
│   ├── .gitignore
│   ├── memory.md
│   ├── rusty -> /srv/repos/rusty
│   └── livingston -> /srv/repos/livingston
├── rusty/                    persona (canonical home)
└── livingston/               persona (canonical home)
```

Unlike a plain persona folder, a persona hub adds no shipped persona template. The prompt stands alone. The remaining structure matches a code hub.

Sessions can start in the hub or in any member.

## Worktree hub

Add `memberRepresentation: "worktree"` to either hub kind to hold code members as nested detached checkouts:

```text
pimote_create_folder { kind: "code-hub", name: "platform", parentPath: "/srv/repos", memberPaths: ["/srv/repos/api", "/srv/repos/web"], memberRepresentation: "worktree" }
```

```text
/srv/repos/
├── platform/                        code hub, worktree mode
│   ├── AGENTS.md
│   ├── .gitignore                   marker line plus one /<member> line each
│   ├── .pimote-hub.json             {"memberRepresentation":"worktree"}
│   ├── api/                         detached worktree of /srv/repos/api
│   └── web/                         detached worktree of /srv/repos/web
├── api/
└── web/
```

Each code member becomes a checkout detached at its source `HEAD`. Source repositories and branches stay untouched, and Pimote performs no branch operation. The user or an agent owns branch work. Persona members always stay symlinks.

Change membership later with `pimote_update_hub_members`. It follows the hub's layout: a new code member detaches in a worktree hub and symlinks in a symlink hub. Never hand-edit inside the managed member block of a hub `AGENTS.md`.

Retire a worktree hub with `pimote_disband_hub`. Never delete one by hand while its checkouts hold work that only the hub's Git still references.

## Never do this

| Attempt                                                      | Symptom                                                                                                               | Fix                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Create a folder inside an included folder                    | The parent shows no children, the new folder never appears, and no session starts in it.                              | Create it under a scan root or an intermediate skipped folder.                             |
| Link an undiscovered directory into a hub by hand            | The walk shows a shortcut, but the folder is not a hub member and removal fails with `Not a member of <hub>: <path>`. | Add it with `pimote_update_hub_members`.                                                   |
| Build a hub by hand and edit its `AGENTS.md` prose           | Membership tools leave the custom lines in place, and disband can reject the hub as edited content.                   | Create hubs with `pimote_create_folder`.                                                   |
| Hand-edit the managed member block                           | Membership edits and the block drift apart, and disband rejects the hub: `Generated hub instructions were edited`.    | Change membership with `pimote_update_hub_members`, and edit prose outside the block only. |
| Move a folder, then read at once                             | Listings lag, and curation stays recorded at the old canonical path.                                                  | Wait for cache expiry, then search again and reapply curation at the new path.             |
| Remove a worktree member with uncommitted changes            | Rejection: `Worktree has uncommitted changes: <checkout>`.                                                            | Commit or discard the changes in that checkout.                                            |
| Disband a hub with an edited generated file or extra content | Rejection: `Generated hub instructions were edited`, or `Unrecognized content in the hub`.                            | Restore the generated files, remove the extra content, and retry.                          |
| Disband a hub whose checkout holds unreachable detached work | Rejection: `Detached HEAD in <checkout> is not reachable from a branch ref`.                                          | Create or push a branch that holds the commit, then retry.                                 |
| Disband a hub with uncommitted hub-level changes             | Rejection: `The hub repository has uncommitted changes`.                                                              | Commit or discard the hub repository changes.                                              |
| Disband a hub while a session or pi process works in it      | Rejection: `Hub is in use by an active session or pi process`.                                                        | Close the session and let external pi processes exit, then retry.                          |
