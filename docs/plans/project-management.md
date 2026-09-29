# Plan: Project Management Redesign

## Context

Replace pimote's minimal project management (one-level scan for git dirs, dumb folder list) with projects as first-class curated entities, recursive extensible discovery, and a global ephemeral manager agent in a new dashboard home. Direction and reasoning: [docs/brainstorms/project-management.md](../brainstorms/project-management.md).

## Architecture

### Impacted Modules

**Protocol** — `FolderInfo`/`list_folders` renames to `ProjectInfo`/`list_projects` and evolves in place: one `path`, `kind: 'single' | 'multi'`, member repos when multi, favorite/order/archived flags. New `RepoInfo` + `list_repos` expose the discovery index (used by multi-repo configuration and creation flows). New command family for project mutations, hub creation, and the manager stream. `Protocol.kt`'s mirrored subset breaks on renames — accepted, Android update explicitly out of scope; its `ignoreUnknownKeys` parsing means field _additions_ are safe but renames are not. Wire field names inside session-scoped events (`folder` on `session_state_changed` etc.) stay unchanged; only the type name ripples.

**Server** — `FolderIndex` is superseded by `RepoIndex` + `ProjectRegistry` (below). `session-manager.ts` gains a manager-session factory path (per-connection, `SessionManager.inMemory`, temp cwd, manager extension factory injected alongside voice/static-host/file-download). `ws-handler.ts` routes the new command family. `config.ts` keeps `roots: string[]`; gains a project-sources directory setting. `git-branch.ts` pattern extends into per-repo git status.

**Web Client** — `+layout.svelte` loses the sidebar. `+page.svelte`'s landing branch becomes the Dashboard: desktop shows projects column and manager chat side-by-side; mobile shows fullscreen projects with a manager-chat affordance. `index-store` evolves into `project-store` (projects, repos, roots, existing per-path sessions map and load-correlation machinery). `FolderList.svelte` evolves into `ProjectList.svelte` preserving search, create-project, archive-all, show-archived; adds favorites, ordering, inline repo chips, project manage menus. New `manager-store` owns manager chat state.

**Android** — untouched by implementation; protocol renames are known-breaking debt for a future mirror update.

### New Modules

**`server/src/repo-index.ts`** — discovery over configured roots plus registered sources. Responsibilities: bounded-depth recursive walk (depth 3; skip `node_modules`, `.git`, `dist`, `build`, `target`, `.venv`; do not follow symlinks except inside hub folders), source registry, TTL cache (~30s) on repo listing, per-repo git status enrichment (branch, dirty, ahead/behind) with its own TTL. Derived state only — no persistence. Dependencies: Protocol for wire types.

**`server/src/project-registry.ts`** — the persistent user-owned layer. Responsibilities: project entities (multi-repo projects; curation overrides — favorite, manual order, archived — keyed by repo path for single-repo projects), JSON persistence following the `session-json-store` pattern, hub-folder creation (mkdir + symlinks validated against the repo index + generated `AGENTS.md` with the sub-project convention), disband (remove entry + delete hub folder), change notifications for `projects_changed` broadcast. Dependencies: RepoIndex (member validation), Protocol.

**`server/src/project-sources/`** — the extensibility seam. `ProjectSource` and `ProjectCreator` interfaces; built-in filesystem walker source and mkdir/git-init creator; loader that dynamic-imports user modules from a configured directory (default `~/.pimote/project-sources/`), isolating failures per module (a broken module logs and is skipped; scan continues). Dependencies: Protocol.

**`server/src/manager/`** — global ephemeral manager. Responsibilities: per-connection lifecycle (create on first manager use, dispose on disconnect, idle reaper as safety net), session built on `SessionManager.inMemory` with an empty temp cwd, streaming reuse of the existing event mapping, and the manager extension that registers pimote toolset. Tools act only through injected pimote server APIs (session-manager, ProjectRegistry, RepoIndex) — never raw fs. Dependencies: session-manager's runtime factory seam, RepoIndex, ProjectRegistry, Protocol.

**Client: `project-store`, `manager-store`, `Dashboard.svelte`, `ProjectList.svelte`, `ManagerChat.svelte`** — as described under Impacted Modules.

### Interfaces

Wire types (Protocol):

```ts
interface ProjectInfo {
  path: string; // repo dir (single) or hub dir (multi)
  name: string;
  kind: 'single' | 'multi';
  /** Member repos; present when kind === 'multi' (hub children). */
  repos?: RepoInfo[];
  favorite?: boolean;
  order?: number; // manual ordering; absent = name sort
  archived?: boolean;
  activeSessionCount: number;
  externalProcessCount: number;
}

interface RepoInfo {
  path: string;
  name: string;
  branch: string | null;
  dirty: boolean;
  ahead: number; // commits ahead of upstream; 0 when unknown
  behind: number;
  /** Epoch ms of last session activity in this repo, when known. */
  lastActivity?: number;
  /** True when the repo path no longer exists on disk (deleted member, broken symlink).
   *  Projects always remain editable: members can be removed regardless of state. */
  missing?: boolean;
}
```

Commands (request/response envelope unchanged): `list_projects` (replaces `list_folders`), `list_repos`, `update_project` (favorite/order/archived flags; single-repo curation writes registry overrides), `create_hub_project` (`{ name, root, repoPaths }` — every `repoPath` must exist in the repo index; hub creation makes symlinks + `AGENTS.md`), `disband_project` (`{ projectPath }` — registry entry removed, hub folder deleted). `manager_prompt` (`{ text }`) and `manager_abort` start/stop runs on the connection's manager session.

Manager stream: server emits `ManagerStreamEvent { type: 'manager_event'; event: PimoteEvent }` — the existing session event mapping reused verbatim inside a wrapper, so the client renders manager output with the same `MessageList` machinery. `projects_changed` broadcasts registry mutations following the `session_state_changed` pattern.

Server seams:

```ts
interface ProjectSource {
  readonly id: string;
  /** Discover repos; called on cache miss. Must not mutate anything. */
  list(): Promise<RepoInfo[]>;
}

interface ProjectCreator {
  readonly id: string;
  /** Human-readable description for the creation UI. */
  describe(): { label: string; paramSchema: Record<string, 'string' | 'string[]'> };
  create(params: Record<string, unknown>): Promise<{ path: string }>;
}
```

`RepoIndex` exposes `list(): Promise<RepoInfo[]>` (marking vanished paths `missing: true` rather than dropping them), `invalidate(): void`, and `registerSource(source: ProjectSource): void`. `ProjectRegistry` exposes `list(overrides merged with index)`, `update(patch)`, `createHub(name, root, repoPaths)`, `disband(path)`, `onChange(cb)`. The manager's tool extension receives a `ManagerToolContext { sessions: SessionManagerPort; projects: ProjectRegistryPort; repos: RepoIndexPort; config }` — narrow ports per DR-039's DI-seam rule, real SDK types at the runtime boundary. Manager session creation reuses `createAgentSessionRuntime(factory, { cwd: tempDir, agentDir, sessionManager: PiSessionManager.inMemory(tempDir) })`.

### Technology Choices

No new dependencies. Recursive walking, symlink handling, and git status use Node fs plus the existing `git` subprocess pattern (`git-branch.ts`). The module loader uses dynamic `import()` of user TS/JS files — same mechanism pi uses for extensions; no sandboxing in v1 (user-authored code is trusted, consistent with pi's extension model). `SessionManager.inMemory` (SDK) covers ephemeral manager sessions; DR-006's chdir patch makes the temp cwd safe.

### DR Supersessions

None. DR-001 (SDK embedding), DR-026 (extension-owns-tools pattern), and DR-039 (real SDK types at boundaries) are followed as-is.

## Tests

**Pre-test-write commit:** `514e9c43a99d07cc5e5ed8b02d8ab587b221dd5f`

### Interface Files

- `shared/src/protocol.ts` — `RepoInfo` / `ProjectInfo` wire types; new commands `list_projects`, `list_repos`, `update_project`, `create_hub_project`, `disband_project`, `manager_prompt`, `manager_abort` (+ `ListProjectsResponseData`, `ListReposResponseData`, `CreateHubProjectResponseData`); `ProjectsChangedEvent` and `ManagerStreamEvent`; all added to the `PimoteCommand` / `PimoteEvent` unions.
- `server/src/repo-index.ts` — `RepoIndex` class stub: `list()` (TTL-cached discovery + git-status enrichment), `invalidate()`, `registerSource()`, `RepoIndexOptions` (ttlMs, statusTtlMs, injectable clock).
- `server/src/project-registry.ts` — `ProjectRegistry` class stub: `list()` (index + overrides merge), `update(patch)`, `createHub(name, root, repoPaths)`, `disband(path)`, `onChange(cb)`; `ProjectUpdatePatch`.
- `server/src/project-sources/types.ts` — `ProjectSource` and `ProjectCreator` interfaces, `ProjectCreatorDescriptor` / `ProjectCreatorParamType`.
- `server/src/project-sources/loader.ts` — `loadProjectSources(dir)` stub returning `LoadedProjectSources` (`{ sources, creators }`); user-module contract: modules export `sources` / `creators` arrays; per-module failure isolation; missing dir → empty.
- `server/src/manager/types.ts` — `ManagerToolContext` with narrow DI ports per DR-039: `SessionManagerPort` (`getAllSessions(): ManagedSessionSummary[]`), `ProjectRegistryPort`, `RepoIndexPort`.
- `server/src/manager/service.ts` — `ManagerService` stub (`getOrCreate(clientId)`, `disposeClient(clientId)`, `sweepIdle()`), `ManagerSession` handle (`session`, `onEvent(cb)`, `dispose()`), `ManagerSessionFactory` seam over session-manager's runtime factory, `ManagerServiceOptions` (idleTimeoutMs, injectable clock).
- `server/src/manager/extension.ts` — `createManagerExtension(context): ExtensionFactory` stub (registers the pimote toolset acting only through the context).
- `server/src/config.ts` — `projectSourcesDir?: string` setting (default resolved in `paths.ts` as `PIMOTE_PROJECT_SOURCES_DIR`).

### Test Files

- `server/src/repo-index.test.ts` — recursive discovery bounds, excluded dirs, symlink non-following, multi-root, registered sources incl. `missing` marking, listing TTL + invalidate, git status enrichment (branch/dirty/ahead-behind) and its separate TTL.
- `server/src/project-registry.test.ts` — single/multi project listing and merge, curation overrides, hub creation (symlinks + AGENTS.md) and validation, disband (incl. single-repo safety refusal), persistence across instances, change notifications + unsubscribe.
- `server/src/project-sources/loader.test.ts` — module collection, per-module failure isolation, non-module files ignored, missing directory → empty.
- `server/src/manager/service.test.ts` — create-on-first-use, per-connection isolation, dispose-on-disconnect + recreate, idle reaper (reaps beyond timeout, spares recent use, tolerance of unknown clients).

### Behaviors Covered

All new tests are red at this phase (stubs throw `not implemented`); the full pre-existing suite (server 554, client 542) stays green.

#### RepoIndex

- Discovers git repos up to three directory levels below each configured root; deeper repos are not listed.
- Does not descend into `node_modules`, `.git`, `dist`, `build`, `target`, `.venv`.
- Does not follow symlinks pointing outside the scanned tree.
- Discovers across all configured roots.
- Merges repos contributed by registered `ProjectSource`s into listings.
- Lists paths that vanished from disk with `missing: true` instead of dropping them.
- Serves a cached listing until the listing TTL expires; `invalidate()` forces an immediate re-walk.
- Enriches each repo with branch, dirty flag, and ahead/behind counts; ahead is 0 with no upstream and counts commits after a push.
- Caches git status on its own TTL, independent of the listing TTL.

#### ProjectRegistry

- Lists every discovered repo as a `single` project with no curation flags applied.
- Applies `favorite` / `order` / `archived` overrides to single-repo projects.
- Rejects updates for unknown project paths.
- Creates a hub project: directory under the chosen root, symlink per member repo, non-empty generated `AGENTS.md`; listed as `multi` with member `RepoInfo`s.
- Rejects hub creation when any member is missing from the repo index and creates nothing.
- Disbands a hub: registry entry removed, hub folder deleted, member repos untouched.
- Refuses to disband a single-repo project or an unknown path.
- Persists hubs and overrides across registry instances (session-json-store pattern).
- Fires `onChange` subscribers exactly once per mutation; unsubscribe stops notifications.

#### Project sources loader

- Collects `sources` and `creators` exported by every module in the configured directory.
- Isolates failures per module: a module that throws or fails to parse is skipped; the rest load.
- Ignores non-module files; a missing directory yields empty results.

#### ManagerService

- Creates the connection's manager session on first use and reuses it for that connection.
- Keeps separate manager sessions per connection.
- Disposes a connection's session on disconnect and recreates it on next use; disposing an unknown client is a no-op.
- Reaps sessions idle beyond the timeout as a safety net; spares sessions used recently; a reaped session is recreated on next use.

#### Deferred to implementation (noted for review)

- The physical `FolderInfo`→`ProjectInfo` / `list_folders`→`list_projects` rename: the new surface is materialized additively here; swapping the old surface ripples through ws-handler routing, client stores, and the Android mirror and belongs with implementation wiring. Wire field names in session-scoped events are untouched, per the plan.
- Client interfaces (`project-store`, `manager-store`, Dashboard/ProjectList/ManagerChat): the plan's Interfaces subsection defines no client contracts beyond the wire protocol materialized above; the stores evolve existing index-store machinery and get their behavioral tests with their implementation.
- Hub-folder symlink-following exception in the walker (depends on the generated-AGENTS.md marker convention that hub creation itself defines); the general no-symlink-following rule is covered.
