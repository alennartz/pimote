# Manual Testing — manager-lifecycle

Topic: the manager becomes a persona folder (commits `73dcbd5..eb2083e`).
Plan: `docs/plans/manager-lifecycle.md`. Brainstorm:
`docs/brainstorms/manager-lifecycle.md`.

## Smoke Suite

Focus hints scope this run to the manager cutover, so the smoke subset is
the two journeys whose manager half this topic rewired:

- **Journey 12 (Dashboard: folders, hubs, and manager)** — driver
  `tools/manual-test/project-management-smoke/` (full run) and
  `tools/manual-test/manager-tools-smoke/` (deterministic toolset probe).
  The cutover replaced the per-connection ephemeral manager with a
  persisted persona folder and ordinary sessions; the whole manager half
  of this journey changed shape.
- **Journey 1 (Connect and open a session)** — the dashboard half only,
  via `project-management-smoke`: manager sessions are now ordinary
  sessions, so this journey's open/resume/back machinery carries them.

Journeys 2–11 and 13 are not re-run this topic: they do not touch the
manager cutover surfaces. Journey 11 is adjacent (manager artifacts moved
to ordinary session panels/downloads) but its driver
(`file-downloads-smoke`) fails at `73dcbd5` before this work — known
pre-existing, not attributed to the cutover.

## Topic-Specific Tests

1. **Seeding on fresh boot** — a fresh environment boot creates the
   default manager root (`~/.local/state/pimote/manager` in the sandbox
   HOME) with a persona-marker `AGENTS.md` (`kind: persona`,
   `name: manager`, one-line description) and a `memory.md` stub. Why:
   the manager's identity as a persona folder exists only if the seed
   lands. Driver: new `tools/manual-test/manager-lifecycle-smoke/`.
2. **Seeding never touches user files** — restart with user-edited
   `AGENTS.md`/`memory.md` leaves them byte-identical; no reseed, no
   merge. Why: destructive seeding would corrupt user personas.
   Driver: `manager-lifecycle-smoke`.
3. **Placement guard** — explicit `managerRoot` that is or contains the
   home directory fails boot with the guidance message; a manager root
   nested in a scan root boots. Why: the home-leak fix (review finding 1)
   and the split-by-harm ruling are boot-critical. Driver:
   `manager-lifecycle-smoke`.
4. **Nested manager root excluded from listings** — with `managerRoot`
   inside a scan root, `list_folders` rows and the sparse tree never
   surface the manager entry, while `list_folders` reports the canonical
   `managerRoot` fact. Why: the listing exclusion is what enforces
   manager-toolset exclusivity (review finding 10 ruling). Driver:
   `manager-lifecycle-smoke` (listing rows) + `manager-tools-smoke`
   (tree view via the manager toolset).
5. **Manager sessions persist across a full server restart** — a
   manager-root session record opens folderless (the manager-root record
   lookup), replays its transcript, and stays resumable after the server
   process is replaced. Why: the brainstorm's core ruling — manager
   sessions are ordinary persisted sessions. Driver:
   `manager-lifecycle-smoke` (wire level) + `project-management-smoke`
   (history-behind-the-click resume, reload reattach).
6. **Persona tools through the manager chat** — the manager chat runs
   `pimote_create_persona`, the new persona folder lands on disk, a
   `folders_changed` delta fires, and the dashboard folder list shows the
   new persona row without reload; `pimote_list_personas` returns working
   directories. Why: the new toolset's user-facing promise. Driver:
   `project-management-smoke` (LLM, jetson-gated) backstopped by
   `manager-tools-smoke` (deterministic execution).
7. **Disconnect during a run + reconnect replay** — reload mid-run keeps
   the session processing server-side; reconnect replays the transcript
   from the client's cursor. Covered by the re-run smoke suite phases
   (driver: `project-management-smoke`); listed here because it is this
   topic's primary ownership behavior.

Items promoted into `PLAN.md` this run: journey 12's manager description
and drivers are updated (persisted persona folder, persona tools,
`manager-lifecycle-smoke`); no new journey — the manager is part of the
dashboard journey.

## Tools

- Reused: `tools/manual-test/project-management-smoke/`,
  `tools/manual-test/manager-tools-smoke/`, shared helpers
  `tools/manual-test/lib/` (sandbox, ws-probe, report, session-dir),
  `agent-browser` skill through `lib/browser.mjs`.
- New: `tools/manual-test/manager-lifecycle-smoke/` — boot/lifecycle
  scenarios for the manager persona root (seeding, placement guard,
  nested-root listing exclusion, restart persistence), WS-probe driven,
  no browser or LLM.
- Improved: `manager-tools-smoke` — deterministic execution of
  `pimote_create_persona` and `pimote_list_personas` (registration was
  already pinned; execution was not). `project-management-smoke` —
  manager-chat persona-tools phase (create → `folders_changed` →
  dashboard row; `list_personas` working directories) and a disk-level
  persisted-session assertion.

## Harness Limitations

- **LLM-dependent phases** (manager chat in `project-management-smoke`)
  use the local `jetson` qwen model. Tool choice is probabilistic; the
  deterministic `manager-tools-smoke` execution backstops it. A model
  refusal can mask tool-wiring bugs in the chat phase alone — mitigated
  by the deterministic backstop.
- **Disconnect-during-run timing** is approximated by a page reload at a
  fixed delay after submit. Boundary races (disconnect exactly at run
  start/end, two viewers racing) are structurally invisible: single-user
  runs, no true concurrency harness. The behavior class itself (viewer
  loss mid-run) is exercised.
- **Sandboxed HOME** — seeding and placement checks run against an
  isolated `os.tmpdir()` HOME. The real `~/.local/state/pimote/manager`
  on this machine is never touched (by design).
- **Boot failure text** is asserted from process exit + log output, not
  from a UI surface (no UI exists for a failed boot).
- Weakened-but-covered: none of the topic's primary behaviors are
  structurally invisible; the gaps above narrow timing classes only.

## Results

(to be filled after execution)

## Plan Updates

(to be filled after execution)

## Open Issues

(to be filled after execution)
