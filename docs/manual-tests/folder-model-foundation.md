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
  the model refuses or the endpoint is down). A wrong tool name could go
  unnoticed by that half alone — compensated by the deterministic
  `manager-tools-smoke` probe, which hard-asserts registration names and
  execution output. Not escalated: the primary behaviors (folder list,
  icons, hub creation, rename) are exercised hard through the wire and the
  real UI; only model compliance is soft.
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

(pending execution)

## Plan Updates

(pending execution)

## Open Issues

(pending execution)
