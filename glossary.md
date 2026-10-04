# Pimote Glossary

Pimote is a PWA + Node.js server and native Android client for remote, voice-first access to pi. Its core object is the **sparse tree** of folders the user works in — code and persistent agents.

## Language

**Code folder**:
A git-initialized folder without persona marker front matter, interacted with as code. Its `AGENTS.md`, if present, holds plain project instructions.
_Avoid_: repo folder, project folder

**Persona folder**:
A folder whose `AGENTS.md` carries persona marker front matter; a persistent agent lives there and interacts only by conferral.
_Avoid_: agent folder, persistent agent folder

**Persona marker**:
The agent-definition YAML front matter (`name`, `description`, `tools`, `model`) at the top of a persona folder's `AGENTS.md`; the body below it is the persona prompt.
_Avoid_: front matter indicator

**Scan root**:
A folder configured in the pimote server config where sparse discovery starts; discovery runs nowhere else. Currently `~/repos` in the deployment.
_Avoid_: root (ambiguous)

**Manager working directory**:
The folder the manager persona agent is rooted at (default `~`). Not a scan root; not in the sparse tree.

**Sparse tree**:
The discovered representation of the user's folders: included folders and shortcut occurrences over skipped path structure.

**Included folder**:
A folder retained in the sparse tree as a code or persona folder.
_Avoid_: retained folder, folder of interest

**Skipped folder**:
A folder traversed during discovery but not retained — plain path structure.

**Shortcut**:
An occurrence created by a top-level out-of-tree symlink in an included folder; entering one restarts discovery from the target.
_Avoid_: reference, link

**Occurrence**:
One place in the sparse tree where an entry appears. Occurrences share the entry's identity.

## Relationships

- A **scan root** anchors discovery: folders are **skipped** until **included** as a **code folder** or **persona folder**
- A **persona folder**'s `AGENTS.md` is an agent definition — **persona marker** front matter plus persona prompt body
- A **shortcut** adds **occurrences** of an entry, never new entries; identity is the canonical path
- A **persona folder** persists by leaving artifacts in its own folder; conversations are ephemeral

## Flagged ambiguities

- "root" was used for both the scan root and the manager working directory — resolved: distinct config settings; the manager working directory is never scanned.
- "repo folder" was used for code folders — resolved: persona folders are git-initialized too, so the nature is **code folder**.
