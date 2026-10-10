# DR-059: The manager is a persona folder with ordinary persisted sessions

## Status

Accepted

## Context

DR-047 made the manager global and ephemeral: one per WebSocket connection, an empty temp working directory, an in-memory session, tools through injected ports only. That fit a manager with no folder and no memory role. The 1.0 substrate needs the manager as chief of staff and future interlocutor for a team of personas. Identity and memory must then survive reloads and reconnects. DR-053 already defines how a persona persists and identifies; an ephemeral manager would be a permanent exception to that model.

User rulings (2026-10-09; cutover ruling 2026-10-04): the manager gains a real folder and persisted sessions; the management toolset stays manager-exclusive; the cutover replaces the old lifecycle outright, with no config flag. Git revert is the rollback.

> Supersedes DR-047 (The manager agent is global and ephemeral), deleted at commit `7a525cb95e37c9a30ef5dc3e52d73a65fc13b37d`.

## Decision

**The manager is a persona folder at `managerRoot`.** The config key names the manager's working directory (default `~/.local/state/pimote/manager`). Its `AGENTS.md` carries the persona marker (`name: manager`) and the mission prompt; `memory.md` holds folder-resident memory. Boot writes each file only when absent. It never overwrites or merges user files.

**Manager sessions are ordinary persisted sessions.** They ride the standard session commands and events, on-disk records, resume, and replay. The manager extension attaches iff the session's canonical cwd equals the canonical `managerRoot` — equality, not containment. We rejected DR-047's per-connection ephemerality: its rationale inverted once the manager became the team's long-lived interlocutor, and the session machinery it avoided exists for every folder anyway. Ephemeral conversations survive only for persona conferrals (P0-3).

**The `pimote_*` toolset stays manager-exclusive.** The injected ports and tools — folders, tree, sessions, repos, plus `pimote_create_persona` and `pimote_list_personas` — attach only to manager sessions. We rejected sharing the toolset with spawned personas: the manager's distinct role is exactly this capability surface. The retired `manager_prompt`/`manager_abort`/`manager_event` wire vocabulary has no replacement; `list_folders` reports the canonical `managerRoot` fact instead.

**Root placement splits by harm.** A manager root that is or contains the home directory fails boot: pi loads ancestor `AGENTS.md` files into every session below, so a seeded manager prompt at `~` would steer every agent on the machine. Scan-root overlap is legal: the manager-root entry is excluded post-detection from folder listings and trees, so no folder row points at it and no ordinary folder session can load the manager tools. We rejected config-time rejection of all overlap (a nested root is legitimate once its entry is hidden) and rejected trusting the "never a scan root" convention (load-bearing but unenforced).

**Straight cutover.** One deployment replaces the old lifecycle; no flag, no dual mode.

## Consequences

- Reload and reconnect preserve the manager conversation; persisted records make manager actions auditable.
- Manager memory is folder-resident (`memory.md`) plus transcripts. True multi-device concurrency is untested territory.
- Tool exclusivity now rests on the listing-exclusion seam (`RepoIndex` `excludeEntryPaths`). Any surface that bypasses the folder model can still reach the manager root by path.
- The client identifies a manager session by lexical path equality against the canonical `managerRoot` fact; the server identifies it by canonical identity. The lexical rule holds because no folder row ever points at the manager root, so UI-opened manager sessions always carry the canonical path. A session reached through a symlink alias would carry manager tools but read as a code session in the UI. The canonical identity fact lives with the server; revisit if manager sessions can surface under alias paths.
- Boot seeding and the placement guard make `managerRoot` part of the boot contract: an unusable root fails startup loudly.
