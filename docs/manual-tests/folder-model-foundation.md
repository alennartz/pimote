# Manual Testing — folder-model-foundation

Topic: sparse folder-model discovery (code/persona classification, shortcuts,
hubs as self-describing git repos), the projects→folders rename across
wire/SDK/manager/client, and the new folder-row UI (4-icon nature × hub
matrix, persona name/description rows).

## Smoke Suite

A subset of `tools/manual-test/PLAN.md`, scoped by the orchestrator's focus
hints to the surfaces this topic touched; the rename reaches every dashboard
and session-open path, so one adjacent journey is spot-checked too.

- **Journey 1 (dashboard half) + Journey 12 — dashboard: folders, hubs, and
  manager** — `tools/manual-test/project-management-smoke/`. This is the
  topic's own journey: folder list load after the rename, favorites /
  archive / tags / hub dialogs, the four row icons, persona display rows,
  hub create/disband with on-disk effects, folder sources, manager chat,
  two-client `folders_changed` sync. Also covers journey 1's dashboard half
  (new session from a folder row, resume, back navigation, warm cache).
- **Journey 13 — AGENTS.md editor** — `tools/manual-test/agents-md-editor-smoke/`
  spot-check only. It boots the same renamed dashboard and clicks its home
  toolbar's "Agent instructions" entry, so it is a cheap guard that the
  rename did not break a sibling dashboard surface sharing the folder store.

Deferred with reasons: journeys 2–8, 10, 11 (drivers untouched by this
topic; their surfaces consume session streams, voice, downloads, updates —
none of which the folder rename altered beyond `session_opened`'s folder
payload, covered below); journey 9 (Android, out of scope per focus hints).

## Topic-Specific Tests

- **T1 — Unscanned-cwd session fallback (`classifyFolder`).** Open and list
  sessions in an arbitrary cwd outside the scan roots: (a) a plain dir →
  synthetic `FolderInfo` with `nature: 'code'`, basename name,
  `shortcutCount: 0`, `favorite/archived/missing` false, `tags: []`;
  (b) a persona-marker dir (`AGENTS.md` with front matter) → `nature:
'persona'` with the marker's `name`/`description`. The cwd must **not**
  appear in `list_folders` merely because a session was opened there.
  Why: hint 5 — the rename replaced `buildProjectInfo` with a fallback
  resolver; unlisted workflows (voice, takeover, replacement) depend on it.
  Tool: extended `project-management-smoke` WS phase.
- **T2 — Manager toolset renamed and functional.** Deterministic probe:
  register the real `createManagerExtension` toolset against a stub pi
  `ExtensionAPI`, execute the folder-view tools against real ports (real
  folder scan + real registry over a fixture tree), and assert: the
  registered names are exactly `pimote_list_folders` / `pimote_folder_tree`
  (no `*_projects`), `pimote_list_folders` returns complete FolderInfo rows
  with schema defaults applied, and `pimote_folder_tree` returns the sparse
  tree shape (occurrences with `path`/`via`/`entry`/`children`; a hub's
  member symlinks surface as `via: 'shortcut'` occurrences referencing the
  member entries). Plus the live-LLM half in `project-management-smoke`:
  the manager chat is prompted to call `pimote_folder_tree` and answer from
  its result (soft on model compliance). Why: hint 4 — the tool rename is
  only observable through the manager; a name mismatch would silently break
  every manager workflow.
- **T3 — Legacy registry read-compat (`multiRepo` → `hubs`).** Replace
  `registry.json` with a pre-rename document (`multiRepo` hub key +
  overrides + user tags), restart the server, and assert the hub row,
  its member `repos`, favorite overrides, and user tags all survive with
  `hubs`-era output shapes. Why: the persistence rename promised read
  compat with no data migration; this is the "existing registry data
  round-trips without loss" clause of the plan.
- **T4 — Vocabulary sweep.** `rg` over `shared/`, `server/src/`,
  `client/src/`, `packages/sdk/` for stale live curated-project tokens
  (`list_projects`, `update_project`, `create_multi_repo_project`,
  `disband_project`, `projects_changed`, `ProjectInfo`, `ProjectRegistry`,
  `project-store`, `ProjectList`) — allowing only the documented
  compatibility seams (push metadata `projectName`, legacy
  `projectSourcesDir` / `project-sources` read compat), historical docs,
  and Android's own naming. Why: "any 'project' breakage is in scope".

Adjacent-flow expansion from the hints (triggers, cleanup, siblings,
residual state), all inside the smoke suite's existing coverage: what
triggers folder rows (discovery scan, folder sources) and what cleans up
after them (disband hub, tag removal, archive); sibling surfaces sharing
folder state (NewSessionDialog picker search incl. persona names,
`list_repos` chips, missing rows, create-folder); residual state
(`registry.json` persistence across restart — warm registry; T3 covers its
legacy shape).

## Tools

- Reused: `tools/manual-test/project-management-smoke/` (journey driver,
  extended — see Improved), `tools/manual-test/agents-md-editor-smoke/`,
  `agent-browser` skill (via the smokes).
- New: `tools/manual-test/manager-tools-smoke/` — deterministic manager
  toolset probe (T2's hard half); no server, browser, or LLM needed.
- Improved: `project-management-smoke` gains three additive phases —
  unscanned-cwd session fallback probes (T1), a manager `pimote_folder_tree`
  prompt (T2's soft half), and a legacy `multiRepo` registry restart check
  (T3). Registered in `tools/manual-test/README.md`.

## Harness Limitations

- The manager-chat half of T2 is driven by the host's local `jetson` model;
  whether it calls a tool is a model choice (assertions soft, marked ⊝ when
  the model refuses or the endpoint is down — the endpoint was in fact
  unreachable during this run, so all live-LLM assertions reported ⊝). A
  wrong tool name could go unnoticed by that half alone — compensated by the
  deterministic `manager-tools-smoke` probe, which hard-asserts registration
  names and execution output. Not escalated: the primary behaviors (folder
  list, icons, hub creation, rename) are exercised hard through the wire and
  the real UI; only model compliance is soft.
- T1 is driven at the WebSocket layer only — no UI path opens a session in
  an arbitrary non-scanned cwd (the fallback serves voice/takeover/
  replacement flows), so the client's rendering of a synthetic folder row is
  not exercised for this case.
- T3 uses a hand-written pre-rename `registry.json`, not a real artifact
  from an old deployment; exotic legacy shapes (malformed entries, legacy
  ordering) are pinned by the server unit suite, not here.
- Concurrency is two WS probe clients + one browser against one server —
  no real multi-user races or load timing.
- Sessions are disk-fabricated (settled state only).
- The build under test includes concurrent uncommitted work by another
  agent in `ws-handler*`, `session-manager.ts`, `session-registry*`
  (panel-resync/ghost-widget workstream) — not this topic's issue; if it
  blocks a test it is noted, not fixed.

## Results

Build under test included the concurrent panel-resync/ghost-widget changes
(`ws-handler*`, `session-manager.ts`, `session-registry*`); they compiled and
blocked nothing.

### Smoke Suite

1. **Journey 1 (dashboard half) + Journey 12 — `project-management-smoke`.**
   Run: `npm run build`, then
   `PM_SHOTS=/tmp/pm-shots node tools/manual-test/project-management-smoke/project-management-smoke.mjs`
   (iterated three times while harness fixes landed; final run exit 0,
   **144 ✓, 0 ✗**). Observed: sparse discovery rows (nested entries 1–3
   levels under the skipped `gamma` wrapper, never inside included repos),
   FolderInfo defaults + basename names on every row, the four row icons
   (beta=code, west=code-hub, omega=persona, sigma=persona-hub), persona
   name/description rows, favorites round-trip and favorites-first ordering,
   tag add/search/persist/remove, archive/show-archived, hub create/disband
   at both the WS and UI level with full on-disk effects (absolute member
   symlinks, `git init`, root-anchored `.gitignore`, generated AGENTS.md;
   member repos untouched by disband; refusal paths for plain folders and
   source hubs), `onFolderOpen` source provisioning, session
   new/resume/active-dot/back-nav/warm-cache, missing-member chip after
   restart, and the mobile layout. Manager-chat half: composer, send→abort
   state swap, side-by-side panel, abort + frozen stream, ephemeral
   transcript — all pass; the live-LLM reply/tool-choice phases are
   **environment-bounded** (5 ⊝: the seeded model endpoint
   `http://jetson.ordernet:8080/v1` was unreachable this run, confirmed with
   curl; the manager renders the provider failure as visible error cards).
   Verdict: **pass**. Coherence: **looks coherent** — screenshots show the
   four icon variants, persona display names with subtitles, favorites-first
   stars, hub member chips with branch/dirty dot, removable user tags, the
   missing chip ("beta missing"), and the hub dialog in hub vocabulary.
2. **Journey 13 — `agents-md-editor-smoke` (spot check).** Run:
   `AM_SHOT=/tmp/agents-md-editor.png node tools/manual-test/agents-md-editor-smoke/agents-md-editor-smoke.mjs`
   — 34 ✓, exit 0. Verdict: **pass**. Coherence: **looks coherent** — dialog
   title, resolved path, Tag/note/todo toolbar, editor content, Cancel/Save.

### Topic-Specific Tests

3. **T1 — unscanned-cwd session fallback (`classifyFolder`).** 7 ✓ inside
   the pm-smoke WS phase: `list_sessions` finds a fabricated session in a
   plain unscanned cwd; `open_session` in a plain dir serves name=basename,
   `nature: 'code'`, no persona, `shortcutCount: 0`, plain defaults; a
   persona-marker cwd serves `nature: 'persona'` with the front-matter
   name/description and basename folder name; neither cwd appears in
   `list_folders` afterwards. Verdict: **pass**. Coherence: n/a (wire-level
   journey; UI rendering of a synthetic row is structurally covered by the
   fallback shape but not rendered — see Harness Limitations).
4. **T2 — manager toolset renamed and functional.** Hard half:
   `node tools/manual-test/manager-tools-smoke/manager-tools-smoke.mjs` —
   28 ✓ (real `createHub` materialization incl. git-ignored member links and
   clean `git status`; all seven tools registered under folder vocabulary
   with zero `project` names and the old names absent; `pimote_list_folders`
   rows carry required defaults and persona metadata and never the persona
   name as folder name; `pimote_folder_tree` returns occurrences with
   `path`/`via`/`entry`/`children`, hub member symlinks as `via: 'shortcut'`
   occurrences referencing the member canonical entries, shared entry
   identity between scan and shortcut occurrences, no truncation on a small
   tree; `pimote_list_repos`/`pimote_list_sessions` execute). Soft half
   (pm-smoke manager prompts for `pimote_list_folders`/`pimote_folder_tree`):
   **environment-bounded** — the model endpoint was unreachable; with the
   hardened role-scoped detection the run reports ⊝ honestly (no phantom
   tool calls). Verdict: **pass**. Coherence: **looks coherent** — the manager
   panel renders per-prompt provider-error cards and the tool phase's
   structural surfaces (composer, abort, panel) hold up.
5. **T3 — legacy registry read-compat (`multiRepo` → `hubs`).** 5 ✓: a
   hand-written pre-rename `registry.json` (`multiRepo` + `overrides`) loads
   unchanged after restart — hub row with both member repos and
   `shortcutCount: 2`, favorite override and removable user tag intact — and
   the next curation write persists the `hubs` key with `multiRepo` retired.
   Verdict: **pass**.
6. **T4 — vocabulary sweep.** `rg` across `shared/src`, `server/src`,
   `client/src`, `packages/sdk/src`: zero stale curated-project tokens
   (`list_projects`, `update_project`, `create_multi_repo_project`,
   `disband_project`, `projects_changed`, `ProjectInfo`, `ProjectRegistry`,
   `project-store`, `ProjectList`, `create_project`, …). Remaining `project`
   occurrences are the documented seams: wire/session/push metadata
   `projectName`, legacy `projectSourcesDir`/`project-sources` read compat,
   historical comments describing the rename, and review finding 19's
   deferred `newSessionInProject`. One stale live comment found —
   `RepoInfo.missing`'s doc comment said "Projects always remain editable" —
   **fixed-inline** to hub vocabulary (commit `cd0d335`); comment-only, no
   behavioral change, no DR consideration needed. Verdict: **fixed-inline**.

Harness fixes made along the way (test tooling, not product — no DR
consideration): the pm-smoke `.gitignore` expectation had drifted from the
review-10 root-anchored pattern form (updated); manager tool-call/reply
detection matched user prompt text and false-positived when the model was
down (hardened to `.tool-block .tool-name` / `.assistant-message`
role-scoped selectors); one injected-eval escape bug. The pre-existing PONG
reply check had the same prompt-text flaw and was hardened in the same pass.

## Plan Updates

- **Journey 12 (modified):** driver line extended —
  `tools/manual-test/manager-tools-smoke/` added as the deterministic
  manager-toolset driver (registration + execution against real ports),
  backstopping the LLM-dependent tool-choice assertions in the
  `project-management-smoke` chat phase.
- **Journey 1 (modified):** added the unscanned-cwd session fallback facet —
  sessions open and list in cwds outside the scanned folders via a synthetic
  classified folder row (`classifyFolder`), without curating the cwd.

## Open Issues

- **Review finding 19's deferred half is still open.**
  `newSessionInProject` (`client/src/lib/stores/session-registry.svelte.ts`
  and its `ActiveSessionBar.svelte` import/call) retains project vocabulary.
  It is explicitly blocked on the concurrent panel-resync/ghost-widget work
  in `session-registry*`/`ws-handler*` (do-not-touch this run); rename to
  folder vocabulary once that lands. All other `project` occurrences in
  live code are documented compatibility vocabulary (see T4).
- Recorded, not an issue: the manager's live-LLM journey (streamed reply,
  tool choice) could not be verified end-to-end this run because the seeded
  model endpoint was unreachable. The manager toolset itself is covered
  deterministically by `manager-tools-smoke`; the chat transport is covered
  structurally. Re-run the chat phase on a host with `jetson.ordernet`
  reachable for full journey coverage.
