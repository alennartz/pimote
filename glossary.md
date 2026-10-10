# Pimote Glossary

Pimote is a PWA, Node.js server, and native Android client for remote access to pi. Its folder model represents code folders and persistent-agent personas discovered beneath configured scan roots.

## Language

**Folder**:
A filesystem directory included in Pimote's folder model as code or persona.
_Avoid_: project (except in retained wire metadata such as `projectName`)

**Code folder**:
An included folder with a `.git` marker that is not a persona folder. Its `AGENTS.md`, if present, holds plain project instructions.
_Avoid_: repo folder, project folder

**Persona folder**:
An included folder that is home to a persistent agent, identified by its persona marker.
_Avoid_: agent folder, persistent agent folder

**Persona marker**:
The YAML front matter at the start of a persona folder's `AGENTS.md` that carries `kind: persona`; optional string `name` and `description`; the file body is the persona prompt.
_Avoid_: front matter indicator

**Scan root**:
A folder configured in the pimote server config where sparse discovery starts; discovery runs nowhere else.
_Avoid_: root (ambiguous)

**Manager root**:
The manager agent's working directory, configured by `managerRoot` (default `~`); it is never a scan root.
_Avoid_: manager working directory

**Sparse tree**:
The discovered representation of the user's folders: included folders and shortcut occurrences over skipped path structure.

**Skipped folder**:
A folder traversed during discovery but not included — plain path structure, collapsed into occurrence paths.
_Avoid_: intermediate folder

**Included folder**:
A folder retained in the sparse tree as a code folder or persona folder.
_Avoid_: retained folder, folder of interest

**Folder entry**:
The identity of an included folder, keyed by its canonical path; one entry can appear at multiple occurrences.
_Avoid_: project entry

**Occurrence**:
One appearance of a folder entry in the sparse tree — its reach path and how discovery got there. Occurrences share the entry's identity.
_Avoid_: node, copy

**Shortcut**:
An occurrence reached through a top-level symlink in an included folder that points outside that folder; discovery restarts at the target.
_Avoid_: reference, link

**Hub**:
A code folder composed of other code folders: one top-level symlink per member repo, its own `git init` + `.gitignore`, and a generated `AGENTS.md` naming the members.
_Avoid_: multi-repo project

**Folder registry**:
Pimote's persisted user curation of folders — favorite/archive state, tags, and hub membership — keyed by canonical folder path.
_Avoid_: project registry

**Folder source**:
A user module that contributes folder entries to Pimote's folder model.
_Avoid_: project source

**Pinned order**:
The fixed folder order one connection's folder listing pages over: favorite first, then most recent activity, then name, then path. It holds order only. Each window resolves its rows fresh. A connection pins one.
_Avoid_: sort snapshot, page order

**Order token**:
The wire handle that names a pinned order. Window requests carry it, so one request stream covers one stable order. Only the owning connection may use it.
_Avoid_: pin id

**Repin**:
An explicit refresh that replaces a connection's pinned order with a fresh one and returns the new order token.
_Avoid_: reorder, rescan

**Listing window**:
One offset/limit slice of a pinned order. It is the unit `list_folders` serves (default 100 rows, clamped to 1–200).
_Avoid_: page

**Two-tier search**:
The folder listing's server-side search over the whole set, fetched or not. A row matches its folder tier (display name, name, path, tags) or its session tier (session name, first message).
_Avoid_: filter, full-text search

**Matched sessions**:
The session ids that a session-tier match hit, carried on the row as `matchedSessionIds`. They narrow the row's lazy session list. Folder-tier matches carry none.
_Avoid_: session hits

**Folders-changed delta**:
The `folders_changed` event: changed rows, removed paths, and a bumped wire epoch. It never carries the full list.
_Avoid_: folders_changed broadcast

**Wire epoch**:
The monotonic counter that every folders-changed delta bumps. A listing response carries the epoch it was computed under. Clients drop responses older than the newest delta they have seen.
_Avoid_: version, revision

**Fetched frontier**:
The client-side boundary between listing windows already fetched and rows still only on the server. Continuation windows resume at the frontier, not at the display position.
_Avoid_: display subset

**Agent instructions file**:
The user-level `~/.pi/agent/AGENTS.md` file that supplies instructions to pi agents.
_Avoid_: project instructions (ambiguous with a code folder's `AGENTS.md`)

**File-edit command**:
A server-level WebSocket command for reading or atomically writing a file by path, independent of any session.
_Avoid_: session file command

**Tag snippet**:
A user-configured tag name offered as a one-tap wrapper in the Agent instructions editor; configured with `tagSnippets` in Pimote's config file.
_Avoid_: tag template

## Relationships

- A **scan root** anchors discovery: folders are **skipped** until **included** as a **code folder** or **persona folder**
- A **persona folder**'s `AGENTS.md` is an agent definition — **persona marker** front matter plus persona prompt body
- A **shortcut** adds **occurrences** of an entry, never new entries; identity is the canonical path
- A **hub** is an ordinary code folder the folder model discovers like any other; its shortcuts point at its members
- The **folder registry** curates discovered folders; **folder sources** can contribute additional entries
- A **persona folder** persists by leaving artifacts in its own folder; conversations are ephemeral
- The **manager root** is distinct from scan roots and is never scanned as part of the sparse tree
- A connection owns one **pinned order**: **listing windows** slice it, and the **order token** names it on the wire
- A **repin** replaces a pinned order. Rows merge by canonical path, so windows across pins never duplicate
- **Two-tier search** filters the whole set. **Matched sessions** narrow only the session lists of session-tier rows
- Every **folders-changed delta** bumps the **wire epoch**. Clients drop listing responses older than the newest delta they have seen
- Continuation **listing windows** resume at the **fetched frontier**

## Flagged ambiguities

- "root" was used for both the scan root and the manager working directory — resolved: distinct config settings as **scan root** and **manager root**; the manager root is never scanned.
- "repo folder" was used for code folders — resolved: persona folders are git-initialized too, so the nature is **code folder**.
- "epoch" named both timestamp values ("ms since epoch") and the folder listing's monotonic counter — resolved: the counter is the **wire epoch**; "epoch ms" stays reserved for timestamps.
- "chips" named folder-row status indicators (repo branch/dirty, missing member, tags) and the active-session bar's open/bound-session buttons — resolved by the `server-folder-list-paging` plan: bare **chips** means the active-session bar's buttons (client-local state that feeds the live re-sort); folder-row indicators are always qualified (repo chips, tag chips, warning chip).
