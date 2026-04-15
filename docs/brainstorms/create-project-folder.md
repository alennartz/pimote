# Brainstorm: Create Project Folder

## The Idea

Add the ability to create a new project folder under one of the configured roots, directly from the pimote UI. Currently the folder list is discovery-only — it scans roots for directories with project markers (`.git`, `package.json`). There's no way to create a new project without SSH-ing in.

## Key Decisions

- **`git init` on creation.** A bare `mkdir` would leave the folder invisible (no project marker). Running `git init` gives it `.git` immediately so it appears in the folder list. This is the simplest marker that doesn't assume a language ecosystem.

- **Trigger from the new session picker dialog.** The user is already in a "start working on something" flow when they open the picker. Adding project creation here means the full flow is: create folder → land in a session. No extra navigation.

- **Skip root selection when there's only one root.** If the config has a single root, go straight to the name input. Multiple roots show a root picker first.

- **Basic name validation only.** Non-empty, no slashes, reject if a directory with that name already exists under the chosen root. No further restrictions.

## Direction

Small end-to-end feature touching protocol, server, and client:

1. **Protocol** — new `create_project` command (name + root path) and response/error.
2. **Server** — handler that validates the name, `mkdir` + `git init`, returns the new folder path. Refresh the folder index so the new project appears.
3. **Client** — UI addition inside the existing new session picker dialog: a "create new project" option that flows through root selection (if needed) → name input → creation → opens a new session in the created folder.

## Open Questions

None — scope is clear.
