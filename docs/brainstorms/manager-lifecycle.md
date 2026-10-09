# Brainstorm: Manager lifecycle — the manager becomes a persona folder

Date: 2026-10-09 · Status: converged · Source: pull `P0-2.2-manager-lifecycle.md` (product-manager repo) plus rulings made in this session. **Where this artifact conflicts with the pull brief, this artifact wins** — it records the user's latest word.

## Idea

The manager stops being a per-connection special case and becomes a regular persona folder: the IDE's chief of staff, and eventually the main interlocutor for a team of personas built up in the IDE (that team vision is P0-3's work; this pull lays its groundwork).

## Key decisions and why

1. **Manager = persona folder at `managerRoot`.** A server config key names the manager's working directory, default `~`. `AGENTS.md` at that root is a persona definition in the my-pi front-matter format (`name`, `description`, …, body = persona prompt). Identity is the folder; no special-case lifecycle code. Why: the folder model (DR-053) already says how personas persist and identify; the manager should not be an exception to it.
2. **Manager sessions are ordinary persisted sessions.** Same mechanics as any code folder's sessions: persisted in the working directory, listed, resumable, standard chat UX with all associated features. Bound to the WebSocket for now. Why: once the manager has a real folder, the DR-047 rationale for an in-memory, temp-dir, per-connection session evaporates. **This supersedes the brief's acceptance criterion 2** ("conversations ephemeral; no session-file persistence reintroduced") — that line carried over from when the manager had no folder. Ephemerality stays the rule for P0-3 persona _conferrals_, not for the manager.
3. **The `pimote_*` management toolset stays manager-exclusive.** No shared persona tool package; the brief's "tool seam shared with P0-3 personas" section is dead by user ruling. What makes the manager special is exactly this injected toolset (folders, hubs, sessions, personas) on top of the standard pi agent tools. The old DR-047 ports-only restriction (no raw fs, empty temp dir) dies with the old lifecycle.
4. **Toolset changes in this pull:**
   - `create_persona` — scaffolds a persona folder: templated `AGENTS.md` (pre-seeded persona prompt template, including the instruction to maintain `memory.md`) plus `memory.md`, placed under a scan root so discovery picks it up. Why a tool: the scaffold contract (front matter, memory link, scan-root placement) is exactly what raw `bash` gets subtly wrong.
   - Persona listing — personas returned with their working directories. Why: with folder paths in hand, the manager can later spawn agents in persona folders and relay messages on the user's behalf (P0-3). No persona-retirement tool in this pull.
5. **Seeding.** The server ships a default manager `AGENTS.md`; at boot it is written into `managerRoot` only if the file does not exist. Existing files are never touched or merged. Seed content: mission statement plus the `memory.md` indication — no tool listing (tools are injected; listing them is redundant). Seed also creates `memory.md` if missing.
6. **Dashboard surface.** The manager stays a pinned home surface, not an entry in the folder list (manager root is never a scan root — already DR-053). Text box: continues the session currently being viewed; starts a new session from the manager landing. Old manager sessions are hidden behind a click — visible on demand for jump-back/resume, never deleted by reset. "Reset" is just "new session".
7. **Cutover.** Straight replacement in one deployment — no config-flag fallback; git-revert is the rollback path (user ruling 2026-10-04, unchanged). The pi-065 disposed-session bug fix and its regression test fold into this pull. Old manager lifecycle code is removed by end of pull.

## Sharp questions for architecting

- pi-065: fix mechanics in the new spawn path (upstream fix vs pimote-side workaround) and the regression test.
- Session lifecycle: what replaces DR-047's idle reaper; what websocket-bound means across reconnect; disconnect must not kill a running session.
- Seeding edge cases: existing `AGENTS.md` without front matter; non-default `managerRoot`; idempotency of boot seeding.
- Does front matter in `~/AGENTS.md` misbehave when a plain-pi session (outside pimote) opens at `~`?
- `create_persona` placement validation contract (which scan roots, name collisions) and final template text.
- Where the manager tool implementations now live: the injected ports (session-manager, folder registry, repo index) remain the internal seam behind the tools — manager-exclusive, not persona-general.

## Fog (dies with this artifact unless promoted)

- How P0-4 will enforce manager-only tool exclusivity by construction.
- Whether the manager persona front matter should pin a model.
- True multi-device concurrency beyond "bound to websocket for now".
