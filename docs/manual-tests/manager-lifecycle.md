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
- **Tree-row exclusion** of a nested manager root has no wire surface
  outside the manager toolset (`pimote_folder_tree`); verified by server
  unit tests, not this harness. Listing-row exclusion is exercised at a
  real boot.
- **LLM gateway flakiness**: one run lost its model to a transient
  provider hang (zero-token request). The harness re-runs rather than
  treating this as product signal; pi's provider-error surfacing rendered
  it visibly in the transcript.
- Weakened-but-covered: none of the topic's primary behaviors are
  structurally invisible; the gaps above narrow timing classes only.

## Results

### Smoke Suite

- **Journey 12 + journey 1 (dashboard half) — `project-management-smoke`
  (`PM_SHOTS=/tmp/pm-shots-mgrlife node tools/manual-test/project-management-smoke/project-management-smoke.mjs`):
  pass** (169 ✓ / 5 ⊝, exit 0). Manager journeys verified in the green
  run: composer submission opens the manager session on the ordinary
  conversation surface and persists a session record on disk; streamed
  reply; `pimote_list_folders` tool call; abort returns the session to
  idle; reload reconnect restores the persisted transcript; history
  reopening resumes the old record; mobile submission opens the ordinary
  conversation surface. First attempt aborted on a harness bug (a dropped
  `readlink` import in my extension edit) — fixed inline in tooling, no
  product change. Second attempt hit a transient jetson gateway hang (one
  request produced zero tokens for 5.5 min, then aborted; pi surfaced a
  `provider error / Connection error` block and recovered) — environment,
  not product; the green re-run confirms.
  Coherence: looks coherent — the manager conversation renders as an
  ordinary chat (thought blocks, tool blocks, provider-error surfacing,
  interruption markers); the still-open journey-1 empty session explains
  the `Session … · 0 msgs` pill on the dashboard bar.
- **Journey 12 — `manager-tools-smoke`
  (`node tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs`):
  pass** (all ✓). Nine-tool registration pinned; `pimote_list_folders` /
  `pimote_folder_tree` shape checks unchanged and green.
  Coherence: n/a (no UI).

### Topic-Specific Tests

1. **Seeding on fresh boot** — pass (`manager-lifecycle-smoke` phase 1):
   default manager root created with a persona-marker `AGENTS.md`
   (`kind: persona`, `name: manager`, nonempty one-line description,
   maintain-`memory.md` indication, no tool listing) and a nonempty
   `memory.md` stub.
2. **Seeding never touches user files** — pass (phases 2–3): restart is a
   byte-identical no-op; user-edited `AGENTS.md`/`memory.md` survive
   restarts byte-identical, and the wire-level folder classification
   reflects the user's file, not the shipped seed.
3. **Placement guard** — pass (phase 7): `managerRoot: "~"` and a
   manager root containing home both fail boot non-zero with the
   home-containment rule and the fix guidance in the log.
4. **Nested manager root excluded** — pass for listing rows (phase 8):
   nested config boots, `list_folders` reports the canonical `managerRoot`
   fact, the manager entry is not a folder row, the sibling folder still
   lists. Tree-row exclusion has no wire surface outside the manager
   toolset; it is pinned by `index.test.ts`/`repo-index.test.ts` (unit),
   recorded under Harness Limitations.
5. **Manager sessions persist across full restart** — pass (phases 4–6):
   manager-root records list (`list_sessions`), open folderless
   (`disk_full_resync` + full transcript replay), survive a full server
   restart and reopen behind the click.
6. **Persona tools through the manager chat** — pass for `create_persona`
   (`project-management-smoke` persona phase): tool call rendered,
   persona folder materialized (front matter, maintain-`memory.md`
   instruction, `memory.md` stub), `folders_changed` delta broadcast, and
   the new `zeta-guide` row renders in the dashboard folder list without
   reload (persona icon + description subtitle — matches sibling persona
   rows). `pimote_list_personas` tool choice was soft (the model answered
   the working directory from context instead of calling the tool; the
   reply carried the correct path); the tool's contract is exercised
   exactly by `manager-tools-smoke` (workingDirectory = canonical
   folderPath). Coherence: looks coherent (see screenshot
   `09-manager-persona.png`).
7. **Disconnect during a run + reconnect replay** — pass, deterministic
   (`manager-lifecycle-smoke` phase 5): a bash run in flight when the
   viewer disconnects keeps processing server-side; the reconnecting
   client reattaches with `incremental_replay` from its cursor, receives
   exactly the buffered events after the cursor, and sees the completed
   output. The LLM-count variant in `project-management-smoke` is soft
   (local model too slow to finish the count in-window).

### Known pre-existing failures (not attributed to this cutover)

- `file-downloads-smoke`: 2 FAIL starting at "landing snapshot exposes the
  seeded owner session" (folder-listing expander hides disk sessions).
- `static-host-pwa-smoke`: 1 FAIL at "find role button click --name 0
  msgs" (same expander signature).

Both match the documented pre-existing failure at `73dcbd5`.

## Plan Updates

Journey 12 in `tools/manual-test/PLAN.md` modified: the manager half is
rewritten for the cutover — the manager is a persisted persona folder at
`managerRoot` (boot-seeded, placement-guarded) with ordinary sessions
(resumable across restarts, server-owned across disconnects, cursor
replay), the toolset gains `pimote_create_persona`/`pimote_list_personas`,
and the driver list gains `manager-lifecycle-smoke`. No journeys added or
retired.

## Open Issues

None. Two soft-bounded observations recorded above (LLM tool choice for
`pimote_list_personas`; LLM count speed for the disconnect-mid-run
variant) are harness limitations, not product findings; both have
deterministic coverage through `manager-tools-smoke` and
`manager-lifecycle-smoke` respectively.
