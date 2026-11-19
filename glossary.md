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
The persona folder configured by `managerRoot` (default `~/.local/state/pimote/manager`). Boot seeds `AGENTS.md` and `memory.md` when absent, without overwriting user files. It can sit inside a scan root, but discovery excludes its entry from folder listings and trees. It must not be or contain the home directory.
_Avoid_: manager working directory

**Manager session**:
An ordinary persisted Pimote session whose working directory is the manager root. It uses the manager toolset and follows normal conversation navigation and reconnect behavior.
_Avoid_: ephemeral manager session

**Session**:
A persisted conversation with pi, tied to a working folder. Multiple connected clients can observe and send commands in the same live session.
_Avoid_: session owner

**Session identity**:
The Pi session UUID that identifies one persisted conversation, independent of its display name. A different conversation, such as a fork, has a different identity.
_Avoid_: session name, folder path

**Subagent**:
A Pi conversation created and lifecycle-managed as another session's child by my-pi's subagents extension. It has its own transcript and live runtime but is not an independent root session.
_Avoid_: agent (ambiguous with persona), independent session

**Subagent view**:
A full interactive Pimote chat attached to an existing live subagent session. Opening or closing the view does not create or dispose the runtime.
_Avoid_: observer-only view, promoted session

**Session settings**:
The internal runtime state for one session's model, thinking level, and auto-compaction behavior. The web UI presents these controls under **Session details**.
_Avoid_: global settings

**Global settings**:
The home-only settings experience and its manifest of user-level settings files. The web UI labels this experience **Settings**.
_Avoid_: session settings, agent instructions

**Settings file**:
A user-level file Pimote exposes as one tab in the Global settings experience. Settings files can be built-in, named in Pimote configuration, or contributed by a Pimote extension.
_Avoid_: settings document, configuration file (when referring to the tabbed settings surface)

**Web theme**:
A named appearance preset for the Pimote PWA. It pairs Pimote UI color tokens with code-editor syntax colors; selecting it applies both palettes. Agent-hosted static reports can opt into it through the theme helper.
_Avoid_: UI theme, editor theme (when referring to the complete preset)

**Pimote extension**:
A trusted module loaded by the global Pimote extension host from its XDG directory or a user-level Pi package's `pimote.extensions` entries. The host loads it at startup and server-wide reload; it does not receive Pi's `ExtensionAPI`.
_Avoid_: Pi extension, folder-source module (when referring to the generic host)

**Pi extension**:
A module loaded by Pi for a session from Pi's extension locations. When running under Pimote, it reaches session-bound Pimote surfaces through the session bridge, such as the panels EventBus.
_Avoid_: Pimote extension

**Session cost**:
Pi's authoritative whole-session dollar total. Pimote shows it separately from assistant-row costs, with an optional breakdown of input, output, cache-read, and cache-write costs from persisted usage.

**Session observer**:
A connected client attached to a live session. Each observer receives the shared event stream and keeps an independent replay position.
_Avoid_: session owner, session takeover

**Replay cursor**:
An observer's position in a live session's event buffer. A cursor belongs to one buffer: a cursor from an earlier buffer for the same session id (idle reap, server restart, voice reopen) forces a full resync.
_Avoid_: epoch (reserved for the folder listing's **wire epoch**)

**User**:
A connection identity the client presents on the WebSocket URL (`?user=`) and keeps as the per-device `pimote:user` setting. All connections of one user share one open-session set. The name is honor-system; nothing is authenticated.
_Avoid_: account

**User profile**:
The server-side per-user open-session set persisted in `user-profiles.json`. A user's connections reconcile against it; a user with no profile yet is fresh.

**Optimistic entry**:
A user message the composer shows before the server echoes it, keyed by a `clientMessageId`. The echo stamped with that id replaces it; a prompt outcome other than `started` removes it.
_Avoid_: pending message (that is a **queued message**)

**Prompt outcome**:
How pi dispatched a prompt, steer, or follow-up: `started` (began a run), `queued` (joined the active run's queue), or `handled` (an extension command or input handler consumed it).

**Queued message**:
A steer or follow-up waiting in pi's queue for the active run, owned by the client that sent it. An abort returns each queued message to its sender as a draft.
_Avoid_: pending steer

**Assistant message row**:
One assistant message as rendered in Pimote's transcript, normally with one bot icon. Its text, thinking, and tool calls belong to one provider response; matching tool-result usage contributes to its cost breakdown, while a later assistant response has its own row.
_Avoid_: assistant turn (ambiguous with a complete agent run)

**Conversation text**:
User-authored or model-authored text in the active session branch. It excludes tool calls and results, thinking, system entries, and custom display messages.
_Avoid_: full transcript (which includes non-conversational entries)

**Branch point**:
A user or assistant message shared by the active path and one or more alternate continuations. The anchor for tree navigation.
_Avoid_: fork point (fork creates a new session file rather than marking a branch in this one)

**Tree navigation**:
Moving the active leaf to another message in the same session file. Transcript **Redo from here** and branch-explorer **Resume** use this operation. Optional compaction uses pi's default summarizer or custom instructions. pi's `navigateTree`; the wire command is `navigate_tree`.
_Avoid_: fork

**Fork from message**:
Continuing from a chosen user message in a new session file while the original session stays untouched and live. The transcript **Fork from this message** action uses pi's `runtime.fork`; the wire command is `fork`. Fork draft policy restores the selected prompt text (Replace, Append, Prepend, Ignore on conflict).
_Avoid_: redo (redo re-branches in place), branch (reserved for tree navigation)

**Abandoned branch**:
A retained session continuation that is not the currently selected branch.
_Avoid_: old branch

**Collapsed branch segment**:
A linear run in the branch explorer represented by its first and last meaningful messages with its middle hidden.
_Avoid_: intermediate nodes

**Archived session**:
A persisted session marked as archived. Archiving closes its live runtime and observers; unarchiving clears the archive flag but requires an explicit open.
_Avoid_: deleted session

**Voice call holder**:
The client bound to the single active voice call for a session. A forced bind transfers the call, not the session.
_Avoid_: session owner, call owner

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
A folder composed of member folders — top-level symlinks or, for code members in a worktree hub, Git-verified nested detached worktrees — with its own `.gitignore` and an `AGENTS.md` that names its members. A hub can be code or persona; members can be any discovered folder-model entries.
_Avoid_: multi-repo project

**Folder registry**:
Pimote's persisted user curation of folders — favorite/archive state and tags — keyed by canonical folder path.
_Avoid_: project registry

**Folder source**:
A registration by a Pimote extension that contributes folder entries to Pimote's folder model.
_Avoid_: project source

**Hub member**:
A discovered folder-model entry joined to a hub by a top-level symlink or, for a code member, a Git-verified nested detached worktree. The canonical identity remains the source folder; a worktree member also has a separate nested checkout.
_Avoid_: repo-only member

**Managed member block**:
The exact-string region in a hub's `AGENTS.md` that Pimote owns for member link lines. Pimote adds or removes only its seeded lines within the marked block.
_Avoid_: generated AGENTS.md content

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
The `AGENTS.md` file in Pi's effective user-level agent directory. It supplies instructions to Pi agents.
_Avoid_: project instructions (ambiguous with a code folder's `AGENTS.md`)

**File-edit command**:
A server-level WebSocket command for reading or atomically writing a file by path, independent of any session.
_Avoid_: session file command

**Tag snippet**:
A configured tag name offered as a one-tap wrapper in Markdown editors; configured with `tagSnippets` in Pimote's native config.
_Avoid_: tag template

**Subagent content**:
A typed Pimote transcript content block that renders a subagent operation in place of a suppressed native tool call or custom message. It belongs inside the assistant message row and preserves the surrounding content order.
_Avoid_: semantic block (too broad), replacement message (does not describe its placement).

**Subagent operation**:
One typed subagent action represented in a transcript, such as `send`, `respond`, `await`, `delegation`, `completion`, `interrupt`, `teardown`, or `resurrect`. An operation can be finite or progressive.
_Avoid_: stream (ambiguous with transport), semantic operation (too broad).

**Subagent transcript projector**:
The server module that combines native Pi content with provider-owned subagent content, suppresses declared native replacements, preserves content order, and produces the client transcript projection.
_Avoid_: overlay renderer (the client no longer performs native matching).

**Provider hydration**:
The explicit provider operation Pimote calls after Pi loads a session. The provider reads its own persisted native entries and publishes typed final subagent operations for the projector.
_Avoid_: session restore (Pi owns general session reload), semantic replay (provider hydration reconstructs durable state).

## Relationships

- A **scan root** anchors discovery: folders are **skipped** until **included** as a **code folder** or **persona folder**
- A **persona folder**'s `AGENTS.md` is an agent definition — **persona marker** front matter plus persona prompt body
- A **shortcut** adds **occurrences** of an entry, never new entries; identity is the canonical path
- A **hub** is an included folder the folder model discovers like any other; its symlinks or verified nested worktrees represent its **hub members**
- The **folder registry** curates discovered folders by canonical path; **folder sources** can contribute additional entries
- A **persona folder** persists by leaving artifacts in its own folder; persona conferrals are ephemeral, **manager sessions** are not
- The **manager root** is distinct from scan roots; when nested inside one, its entry is excluded from the sparse tree
- A **manager session** is an ordinary persisted session rooted at the **manager root**
- A **Pimote user** uses its saved **web theme** across devices; the server's default theme applies when no choice is saved
- A **session** can have multiple **session observers**, but at most one **voice call holder**
- Each **session observer** keeps its own **replay cursor** into the session's shared event buffer
- One **assistant message row** renders one assistant message; matching tool results contribute to that row's cost, while the later assistant response has its own row
- Only a `started` **prompt outcome** echoes a stamped user message that settles an **optimistic entry**; a `queued` outcome yields a **queued message** instead
- An **archived session** has no live runtime; dashboard unarchiving does not open it, while the explicit manager resume action clears the flag and opens the original record
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
- "user" also names pi's conversation message role — resolved: the role stays in message-content contracts, the identity sense stays in connection/profile contracts; they never share a wire type.
