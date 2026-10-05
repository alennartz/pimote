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
The YAML front matter at the start of a persona folder's `AGENTS.md` that includes its string `name`; the file body is the persona prompt.
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

## Flagged ambiguities

- "root" was used for both the scan root and the manager working directory — resolved: distinct config settings as **scan root** and **manager root**; the manager root is never scanned.
- "repo folder" was used for code folders — resolved: persona folders are git-initialized too, so the nature is **code folder**.
