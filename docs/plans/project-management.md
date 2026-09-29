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

One new dependency: `jiti` (direct server dependency), added so user project-source modules can be authored as TypeScript exactly like pi extensions — pi itself loads TS extensions through jiti, and native Node `import()` cannot load `.ts`. Everything else needs nothing new: recursive walking, symlink handling, and git status use Node fs plus the existing `git` subprocess pattern (`git-branch.ts`); the loader dynamic-imports user TS/JS modules through jiti with no sandboxing in v1 (user-authored code is trusted, consistent with pi's extension model). `SessionManager.inMemory` (SDK) covers ephemeral manager sessions; DR-006's chdir patch makes the temp cwd safe.

### DR Supersessions

None. DR-001 (SDK embedding), DR-026 (extension-owns-tools pattern), and DR-039 (real SDK types at boundaries) are followed as-is.

## Tests

**Pre-test-write commit:** `514e9c43a99d07cc5e5ed8b02d8ab587b221dd5f`

### Interface Files

- `shared/src/protocol.ts` — `RepoInfo` / `ProjectInfo` wire types; new commands `list_projects`, `list_repos`, `update_project`, `create_hub_project`, `disband_project`, `manager_prompt`, `manager_abort` (+ `ListProjectsResponseData`, `ListReposResponseData`, `CreateHubProjectResponseData`); `ProjectsChangedEvent` and `ManagerStreamEvent`; all added to the `PimoteCommand` / `PimoteEvent` unions.
- `server/src/repo-index.ts` — `RepoIndex` class stub: `list()` (TTL-cached discovery + git-status enrichment), `invalidate()`, `registerSource()`, `RepoIndexOptions` (ttlMs, statusTtlMs, injectable clock).
- `server/src/project-registry.ts` — `ProjectRegistry` class stub: `list()` (index + overrides merge), `update(patch)`, `createHub(name, root, repoPaths)`, `disband(path)`, `onChange(cb)`; `ProjectUpdatePatch`.
- `server/src/project-sources/types.ts` — `ProjectSource` and `ProjectCreator` interfaces, `ProjectCreatorDescriptor` / `ProjectCreatorParamType`.
- `server/src/project-sources/builtin.ts` — `createBuiltinCreator(): ProjectCreator` stub: the built-in mkdir + git-init creator backing the dashboard's create-project flow (`{ root, name }` params; rejects when the target folder already exists).
- `server/src/project-sources/loader.ts` — `loadProjectSources(dir)` stub returning `LoadedProjectSources` (`{ sources, creators }`); user-module contract: modules export `sources` / `creators` arrays; per-module failure isolation; missing dir → empty.
- `server/src/manager/types.ts` — `ManagerToolContext` with narrow DI ports per DR-039: `SessionManagerPort` (`getAllSessions(): ManagedSessionSummary[]`), `ProjectRegistryPort`, `RepoIndexPort`.
- `server/src/manager/service.ts` — `ManagerService` stub (`getOrCreate(clientId)`, `disposeClient(clientId)`, `sweepIdle()`), `ManagerSession` handle (`session`, `onEvent(cb)`, `dispose()`), `ManagerSessionFactory` seam over session-manager's runtime factory, `ManagerServiceOptions` (idleTimeoutMs, injectable clock).
- `server/src/manager/extension.ts` — `createManagerExtension(context): ExtensionFactory` stub (registers the pinned listing toolset — `pimote_list_projects`, `pimote_list_repos`, `pimote_list_sessions`, each with empty parameters — acting only through the context).
- `server/src/config.ts` — `projectSourcesDir?: string` setting (default resolved in `paths.ts` as `PIMOTE_PROJECT_SOURCES_DIR`).

### Test Files

- `server/src/repo-index.test.ts` — recursive discovery bounds, excluded dirs, symlink non-following, multi-root, registered sources incl. `missing` marking, listing TTL + invalidate, git status enrichment (branch/dirty/ahead-behind) and its separate TTL.
- `server/src/project-registry.test.ts` — single/multi project listing and merge, curation overrides (single-repo and hub projects), manual-order/name sort listing, hub creation (symlinks + AGENTS.md) and validation (unknown member, existing target folder), disband (incl. single-repo safety refusal), persistence across instances, change notifications + unsubscribe.
- `server/src/project-sources/loader.test.ts` — module collection, per-module failure isolation, non-module files ignored, missing directory → empty.
- `server/src/project-sources/builtin.test.ts` — creator descriptor (`root` + `name` form), mkdir + git init, target-exists rejection touching nothing.
- `server/src/manager/service.test.ts` — create-on-first-use, per-connection isolation, dispose-on-disconnect + recreate, idle reaper (reaps beyond timeout, spares recent use, tolerance of unknown clients).
- `server/src/manager/extension.test.ts` — registers exactly the pinned listing toolset; each tool routes through the injected `ManagerToolContext` ports.

### Behaviors Covered

All new tests are red at this phase (stubs throw `not implemented`); the full pre-existing suite (server 554, client 542) stays green.

#### RepoIndex

- Discovers git repos up to three directory levels below each configured root; deeper repos are not listed.
- Does not descend into `node_modules`, `.git`, `dist`, `build`, `target`, `.venv`.
- Does not follow symlinks pointing outside the scanned tree.
- Discovers across all configured roots; a configured root that does not exist is tolerated.
- Merges repos contributed by registered `ProjectSource`s into listings.
- Lists paths that vanished from disk with `missing: true` instead of dropping them.
- Serves a cached listing until the listing TTL expires; `invalidate()` forces an immediate re-walk.
- Enriches each repo with branch, dirty flag, and ahead/behind counts; ahead is 0 with no upstream and counts commits after a push.
- Caches git status on its own TTL, independent of the listing TTL.

#### ProjectRegistry

- Lists every discovered repo as a `single` project with no curation flags applied.
- Applies `favorite` / `order` / `archived` overrides to single-repo projects and to hub projects.
- Sorts the merged list by manual `order` where set and by name otherwise.
- Rejects updates for unknown project paths.
- Creates a hub project: directory under the chosen root, symlink per member repo, generated `AGENTS.md` naming each member repo and the sub-project convention; listed as `multi` with member `RepoInfo`s.
- Rejects hub creation when any member is missing from the repo index and creates nothing.
- Rejects hub creation when the target folder already exists and leaves it untouched.
- Disbands a hub: registry entry removed, hub folder deleted, member repos untouched.
- Refuses to disband a single-repo project or an unknown path.
- Persists hubs and overrides across registry instances (session-json-store pattern).
- Fires `onChange` subscribers exactly once per mutation; unsubscribe stops notifications.

#### Project sources loader

- Collects `sources` and `creators` exported by every module in the configured directory.
- Isolates failures per module: a module that throws or fails to parse is skipped; the rest load.
- Ignores non-module files; a missing directory yields empty results.

#### Built-in creator

- Describes a creation form asking for `root` and `name`.
- Creates the project folder under the chosen root and git-inits it.
- Rejects creation when the target folder already exists, touching nothing.

#### ManagerService

- Creates the connection's manager session on first use and reuses it for that connection.
- Keeps separate manager sessions per connection.
- Disposes a connection's session on disconnect and recreates it on next use; disposing an unknown client is a no-op.
- Reaps sessions idle beyond the timeout as a safety net; spares sessions used recently; a reaped session is recreated on next use.
- The manager extension registers exactly the pinned listing toolset (`pimote_list_projects`, `pimote_list_repos`, `pimote_list_sessions`); each tool routes through the injected `ManagerToolContext` ports.

#### Deferred to implementation (noted for review)

- The physical `FolderInfo`→`ProjectInfo` / `list_folders`→`list_projects` rename: the new surface is materialized additively here; swapping the old surface ripples through ws-handler routing, client stores, and the Android mirror and belongs with implementation wiring. Wire field names in session-scoped events are untouched, per the plan.
- Client interfaces (`project-store`, `manager-store`, Dashboard/ProjectList/ManagerChat): the plan's Interfaces subsection defines no client contracts beyond the wire protocol materialized above; the stores evolve existing index-store machinery and get their behavioral tests with their implementation.
- Hub-folder symlink-following exception in the walker (depends on the generated-AGENTS.md marker convention that hub creation itself defines); the general no-symlink-following rule is covered.
- Manager toolset semantics beyond the pinned listing tools (session create/manage tools, search parameters, output shaping): the ports they need don't exist yet; they are settled with implementation planning, alongside their tests.
- Ephemeral runtime properties of the real manager session factory (`SessionManager.inMemory`, temp cwd, event-mapping reuse): live behind the `ManagerSessionFactory` seam and get exercised when the factory itself is implemented.

**Review status:** approved

## Steps

**Pre-implementation commit:** `f84bc3a3734a80598d9ea0ec99b36f60b74dc59b`

Grounded in the code as of `13bb344` (test-review). The six new test files hold 42 red tests; steps 1–6 make them pass. Server modules first (they have no upstream dependencies), then wiring, then the physical protocol rename, then the client.

### Step 1: Implement RepoIndex

Fill in `server/src/repo-index.ts` (stub + `RepoIndexOptions` already exist; `ProjectSource` import already resolves).

- **Walker** (private): for each configured root, walk directories up to three levels below the root; a directory containing a `.git` entry is a repo. Use `readdir(..., { withFileTypes: true })`; skip entries where `isSymbolicLink()` (never follow symlinks); do not descend into `node_modules`, `.git`, `dist`, `build`, `target`, `.venv`. A root that is missing or unreadable (ENOENT/EACCES) is skipped with a `console.warn`, matching `FolderIndex.scan`'s degrade-gracefully behavior. Keep walking _through_ discovered repos — `repo-index.test.ts` requires finding a repo three levels deep beneath another repo.
- **Sources**: on each walk, call every registered source's `list()` and merge the results into the listing.
- **Missing marking**: after merging, `stat` each path; ENOENT → keep the entry with `missing: true` (source-contributed paths can vanish; walker-discovered ones exist by construction, but check uniformly).
- **Listing TTL**: cache `{ repos, at }`; serve cached while `now() - at < ttlMs` (default 30_000), else re-walk and re-stamp. `now` = `options.now ?? Date.now`.
- **Status enrichment**: per-path status cache `{ branch, dirty, ahead, behind, at }`, refreshed when `now() - at >= statusTtlMs` (default 30_000). Branch via `getGitBranch` from `git-branch.ts`. Dirty = `git status --porcelain` output non-empty. Ahead/behind: resolve upstream with `git rev-parse --abbrev-ref @{upstream}` (failure → `0`/`0`), then `git rev-list --count <upstream>..HEAD` and `--count HEAD..<upstream>`. All git calls follow the `git-branch.ts` pattern: promisified `execFile`, env guard stripping `GIT_DIR`/`GIT_WORK_TREE`, `timeout: 2000`, catch → neutral value.
- `invalidate()`: clear both caches.

**Verify:** `cd server && npx vitest run src/repo-index.test.ts` — 11 tests green.
**Status:** done (13 tests green — plan count was stale; test file untouched)

### Step 2: Add jiti and extend the loader test contract

- From the repo root: `npm install jiti -w server` (workspace `@pimote/server`; jiti is currently only a hoisted transitive dep of the pi SDK).
- Extend `server/src/project-sources/loader.test.ts` with one case: a `.ts` module exporting `sources` loads alongside the `.mjs` modules. This pins the TS contract that motivates the dependency.

**Verify:** jiti appears in `server/package.json` dependencies; the new loader test case is red.
**Status:** done

### Step 3: Implement project sources (builtin creator + loader)

- `server/src/project-sources/builtin.ts` — `createBuiltinCreator()` returns a `ProjectCreator`:
  - `id`: `'builtin-folder'`.
  - `describe()`: `{ label: 'New project folder', paramSchema: { root: 'string', name: 'string' } }`.
  - `create({ root, name })`: validate first — name non-empty, no `/` or `path.sep`, not `.`/`..` (same rules as the current `create_project` case in `ws-handler.ts`); `root` must exist; target `join(root, name)` must NOT exist (`stat` success → throw) — all before any filesystem mutation. Then `mkdir(target)` and `git init` in it (env-guarded exec, per `git-branch.ts`). Return `{ path: target }`.
- `server/src/project-sources/loader.ts` — `loadProjectSources(dir)`:
  - `readdir(dir, { withFileTypes: true })`; ENOENT → `{ sources: [], creators: [] }`.
  - Consider only regular files ending `.js`, `.mjs`, `.cjs`, `.ts` — everything else is ignored (covers the `.txt`/`.json` test).
  - Load each through jiti (`createJiti(import.meta.url)` once, `jiti.import(fileUrl)` per module — mirrors pi's `jiti-loader.ts`). Per-module `try`/`catch`: a load or evaluation failure logs a warning and is skipped; the scan continues.
  - Collect `mod.sources` and `mod.creators` when they are arrays; return `{ sources, creators }`.

**Verify:** `cd server && npx vitest run src/project-sources/` — loader (5, incl. the new `.ts` case) + builtin (3) green.
**Status:** done

### Step 4: Implement ProjectRegistry

Fill in `server/src/project-registry.ts` (stub and `ProjectUpdatePatch` already exist).

- **Persistence document**: `{ version: 1, hubs: Array<{ path: string; name: string; memberPaths: string[] }>, overrides: Record<string, { favorite?: boolean; order?: number; archived?: boolean }> }` at `join(storeDir, 'registry.json')`. Atomic write (`.tmp` + `rename`) mirroring `FileSessionJsonStore` mechanics — this is a single document, not the per-session keyed store, so reuse the pattern, not the class. Lazy-load on first use via a cached load promise (constructor stays synchronous; tests construct then immediately await methods).
- `list()`: await `repos.list()`. Every repo → a `single` project: `name` = `basename(path)`, override fields spread on when present, `activeSessionCount: 0`, `externalProcessCount: 0` (the WS layer enriches counts; registry tests don't assert them). Every persisted hub → a `multi` project with member `RepoInfo`s resolved against the index; a member path the index doesn't know → `{ path, name: basename, branch: null, dirty: false, ahead: 0, behind: 0, missing: true }`. Sort: entries with `order` ascending first, then the rest by `name` (`localeCompare`) — matches both sort tests.
- `update(patch)`: resolve the merged view (index paths ∪ hub paths); unknown path → throw. Merge the override, persist, fire `onChange` once.
- `createHub(name, root, repoPaths)`: validate before any mutation — valid name, every `repoPath` present in the index (else throw, creating nothing), target `join(root, name)` must not exist (else throw, leaving it untouched). Then: `mkdir` target; `symlink(member, join(target, basename(member)))` per member (absolute targets — the test asserts `readlink` equals the member path); write the generated `AGENTS.md`; persist the hub entry; fire `onChange` once; return `{ path: target }`.
- **AGENTS.md content** (`project-registry.test.ts` asserts it names each member and mentions AGENTS.md case-insensitively): short document titled with the hub name, a bulleted member list (repo name → symlinked directory), and the sub-project convention: each member directory is an independent git repo with its own `AGENTS.md` that takes precedence when working inside it; keep each repo's work inside its own directory.
- `disband(projectPath)`: known hub → `rm(hubPath, { recursive: true, force: true })` (symlinks are unlinked, never followed — members survive, per test), drop the entry, persist, fire `onChange` once. A single-repo project path or unknown path → throw, touching nothing.
- `onChange(cb)`: subscriber set; fire after each successful `update`/`createHub`/`disband`; return an unsubscribe function.

**Verify:** `cd server && npx vitest run src/project-registry.test.ts` — 12 tests green.
**Status:** done (14 tests green — plan count was stale; test file untouched)

### Step 5: Implement the manager extension

Fill in `server/src/manager/extension.ts`.

- `createManagerExtension(context)` returns an `ExtensionFactory` that registers exactly three tools, in this order: `pimote_list_projects` → `context.projects.list()`, `pimote_list_repos` → `context.repos.list()`, `pimote_list_sessions` → `context.sessions.getAllSessions()`.
- Each tool: `parameters: Type.Object({})` (`Type` from `'typebox'`, same import as `static-host/index.ts`), a label, and an LLM-facing description; `execute` awaits the port call and returns the JSON-serialized result as text content per pi's `AgentToolResult` shape. Tools act only through the injected ports — no fs, no server internals.

**Verify:** `cd server && npx vitest run src/manager/extension.test.ts` — 2 tests green.
**Status:** done

### Step 6: Implement ManagerService

Fill in `server/src/manager/service.ts` (types already exist).

- Internal map: `clientId → { session: ManagerSession; lastUsedMs: number }`. `now` = `options.now ?? Date.now`; `idleTimeoutMs` default 1_800_000 (30 min, matching the config `idleTimeout` default).
- `getOrCreate(clientId)`: existing entry → update `lastUsedMs` (every `getOrCreate` is a "use" — the WS prompt path calls it per prompt, which is what makes the reaper's "recently used" semantics work) → return the session. Else `factory({ clientId })`, store with `lastUsedMs = now()`, return.
- `disposeClient(clientId)`: entry → `session.dispose()` (may return a promise — best-effort, swallow rejections), delete. Unknown client → no-op.
- `sweepIdle()`: entries with `now() - lastUsedMs > idleTimeoutMs` → dispose + delete.

**Verify:** `cd server && npx vitest run src/manager/service.test.ts` — 6 tests green.
**Status:** done

### Step 7: Real manager session factory

`server/src/session-manager.ts` gains the factory path the architecture assigns it (no unit tests — this is the seam the test plan defers; it's exercised by the wiring smoke in step 9).

- Expose the process `ModelRuntime` (built in `PimoteSessionManager.create`) via a getter, e.g. `getModelRuntime(): ModelRuntime`.
- Export `createManagerSessionFactory(deps: { config: PimoteConfig; modelRuntime: ModelRuntime; managerExtensionFactory: ExtensionFactory }): ManagerSessionFactory` from `session-manager.ts`. Per call:
  - `mkdtemp(join(tmpdir(), 'pimote-manager-'))` as the session cwd (DR-006's chdir patch makes this safe).
  - Assemble the runtime exactly like `doOpenSession` minus persistence and the voice/static-host/file-download extensions: fresh `createEventBus()`, `createAgentSessionServices({ cwd, agentDir: getAgentDir(), modelRuntime, resourceLoaderOptions: { eventBus, extensionFactories: [managerExtensionFactory] } })`, `createAgentSessionFromServices`, then `createAgentSessionRuntime(factory, { cwd: tempDir, agentDir: getAgentDir(), sessionManager: PiSessionManager.inMemory(tempDir) })`.
  - Streaming: subscribe `session.subscribe` and feed an `EventBuffer` (the existing SDK→wire mapping, so manager output is byte-identical with regular sessions); forward each mapped `PimoteEvent` to `onEvent` subscribers. A small buffer is fine — manager sessions have no replay cursor.
  - `dispose()`: unsubscribe, `runtime.dispose()`, best-effort `rm(tempDir, { recursive: true, force: true })`. Idempotent.
  - Return the `ManagerSession` handle.

**Verify:** `npm run check` still green (tsc server); type-level only.
**Status:** done

### Step 8: Server wiring — construction + DI

- `server/src/paths.ts`: add `PIMOTE_PROJECTS_DIR = join(PIMOTE_STATE_DIR, 'projects')` (registry store dir, alongside the existing static-host/file-download dirs).
- `server/src/index.ts`:
  - Construct `RepoIndex(config.roots)`.
  - `loadProjectSources(config.projectSourcesDir ?? PIMOTE_PROJECT_SOURCES_DIR)`; `registerSource` each loaded source; collect creators as `[createBuiltinCreator(), ...loaded.creators]`.
  - Construct `ProjectRegistry(repoIndex, PIMOTE_PROJECTS_DIR)`.
  - Build the `ManagerToolContext`: `sessions` port maps `sessionManager.getAllSessions()` → `ManagedSessionSummary` (`sessionId`, `folderPath`, `status` from `sessionState.status`, `needsAttention`); `projects`/`repos` ports delegate straight to the registry/index; `config` as-is.
  - `new ManagerService({ context, factory: createManagerSessionFactory({ config, modelRuntime: sessionManager.getModelRuntime(), managerExtensionFactory: createManagerExtension(context) }) })`.
  - Schedule the reaper: `setInterval(() => managerService.sweepIdle(), 60_000)` next to `startIdleCheck`; clear it in the shutdown handler.
- `server/src/server.ts`: `createServer` gains `repoIndex`, `projectRegistry`, `managerService`, `creators` params; constructs each `WsHandler` with them; index.ts passes them through.

**Verify:** `npm run check` green; server boots against a temp config (`npx tsx server/src/index.ts` with `PIMOTE_CONFIG_PATH` pointed at a scratch config).
**Status:** done

### Step 9: WS command routing, broadcast, manager streaming

`server/src/ws-handler.ts` (cases live in the server-level switch alongside `list_folders`):

- `list_projects`: `projectRegistry.list()`, then enrich each project in place — `activeSessionCount` = managed slots with `folderPath === project.path` (exact match, same rule as the `list_folders` enrichment; member sessions count toward their own single projects), `externalProcessCount: 0` (parity with `list_folders`, which never sets it). Respond `{ projects, roots: repoIndex.roots }`.
- `list_repos`: `{ repos: await repoIndex.list() }`.
- `update_project`: `projectRegistry.update({ projectPath, favorite, order, archived })` → success. (The `projects_changed` broadcast in `onChange` covers propagation.)
- `create_hub_project`: validate `root` ∈ `repoIndex.roots`, then `createHub` → `{ projectPath }`.
- `disband_project`: `projectRegistry.disband` → success.
- `manager_prompt`: `const ms = await managerService.getOrCreate(this.clientId)`; install this connection's manager listener on first use (`ms.onEvent(e => this.sendToClient({ type: 'manager_event', event: e }))`, one subscription per connection, stored for cleanup); start `ms.session.prompt(text)` fire-and-forget (same pattern as `prompt`) and respond success immediately — output reaches the client as `manager_event` stream.
- `manager_abort`: `managerService.getOrCreate(this.clientId)` → `session.abort()` → success.
- `projects_changed` broadcast: in `server.ts` (has `clientRegistry` + registry), `projectRegistry.onChange(() => { void projectRegistry.list().then(projects => { for (const [, h] of clientRegistry) h.sendToClient({ type: 'projects_changed', projects }); }) })`.
- `create_project` → route through the builtin creator (find it by `describe().paramSchema` matching `{ root, name }`) instead of the inline mkdir+git-init block; keep the `{ folderPath }` response shape. On success: `repoIndex.invalidate()` then broadcast `projects_changed` — otherwise the 30s listing TTL hides the new repo.
- Disconnect: `cleanup()` also unsubscribes the manager listener and calls `managerService.disposeClient(this.clientId)`.

**Verify:** `npm run check` green; server suite green; manual WS smoke (temp config + `wscat`): `list_projects`, `list_repos`, `update_project`, `create_hub_project`, `disband_project`, `manager_prompt` (streams `manager_event`), `manager_abort`; `projects_changed` arrives after a mutation.
**Status:** done

### Step 10: Physical protocol rename

`shared/src/protocol.ts` + mechanical reference fixes. Android is intentionally untouched — `Protocol.kt` goes stale for renames (accepted debt; its `ignoreUnknownKeys` makes the additions safe but not the renames). Update the header KEEP-IN-SYNC comment to record the pending Kotlin mirror update.

- Delete `FolderInfo` and `ListFoldersCommand`; drop `list_folders` from the `PimoteCommand` union. `SessionOpenedEvent.folder` and `SessionReplacedEvent.folder` become `ProjectInfo` — field names unchanged, per the architecture's wire-compat rule.
- Server: fix remaining references (`ws-handler.ts` `buildFolderInfo` → builds a `ProjectInfo`; anything else the compiler names).
- Client mechanical fix (full evolution is steps 11–14): `index-store.svelte.ts` sends `list_projects` and reads `{ projects, roots }`; `FolderInfo` → `ProjectInfo` in `index-store.svelte.ts`, `session-list-groups.ts` (+ its test), `connection.svelte.test.ts`.

**Verify:** `npm run check` green; full server + client suites green.
**Status:** not started

### Step 11: `project-store` (client)

Evolve `client/src/lib/stores/index-store.svelte.ts` → `client/src/lib/stores/project-store.svelte.ts` (rename file, export `projectStore`, update consumers in the same step so nothing dangles).

- State: `projects: ProjectInfo[]`, `repos: RepoInfo[]`, `roots: string[]`, the per-path sessions `SvelteMap`, `loading`, `showArchived` — the existing single-flight load-correlation machinery for both project and session loads carries over unchanged.
- Actions: `loadProjects()` (replaces `loadFolders`: `list_projects` → seeds per-project session loads), `loadRepos()` (`list_repos`, for the create/manage flows), `applyProjectsChanged(event)` (whole-list replacement), `setShowArchived` (now also filters `project.archived`).
- Event routing: module-scope `connection.onEvent` subscription in the store module (the `login-store.ts` pattern) dispatching `projects_changed`; session-scoped events keep flowing through the existing session-registry path untouched.
- Tests alongside implementation (client vitest, mirroring `index-store` test conventions): `projects_changed` replaces the list; concurrent `loadProjects` single-flights; session map keyed by path still correlates loads.

**Verify:** `cd client && npx vitest run` green including the new store tests; `npm run check` green.
**Status:** not started

### Step 12: `ProjectList.svelte` (client)

Evolve `client/src/lib/components/FolderList.svelte` → `client/src/lib/components/ProjectList.svelte` (rename, rewire to `projectStore`).

- Preserve: search filter, create-project dialog (root + name → `create_project`), archive-all, show-archived toggle, per-project session grouping/expansion (`session-list-groups.ts` machinery).
- Add:
  - Favorite toggle per project → `update_project { favorite }` (star; favorites sort first via `order`-then-name — the favorite flag itself is display state, ordering is manual).
  - Manual ordering (move up/down in the manage menu) → `update_project { order }`.
  - Archived flag: show-archived now also reveals `archived` projects; archive/unarchive in the manage menu → `update_project { archived }`.
  - Inline repo chips on multi projects: member `RepoInfo` name + branch + dirty dot; `missing: true` members render in a warning style.
  - Project manage menu: favorite, order, archive, disband (confirm dialog → `disband_project`), and create multi-repo hub (dialog: name + root + member picker fed by `loadRepos()` → `create_hub_project`).

**Verify:** `npm run check` green; manual smoke — favorite/order/archive persist across reload, hub create/disband round-trips, chips render member state.
**Status:** not started

### Step 13: `manager-store` + `ManagerChat.svelte` (client)

- `client/src/lib/stores/manager-store.svelte.ts`: reduces `manager_event` payloads with the same event→message machinery the session registry uses (message_start/update/end, agent_start/end, tool events); exposes `messages`, `status: 'idle' | 'working'`, `send(text)` → `manager_prompt`, `abort()` → `manager_abort`. Manager sessions are ephemeral per connection — reset the store when the WebSocket drops (reconnect gets a fresh manager).
- `client/src/lib/components/ManagerChat.svelte`: renders the manager transcript through `MessageList` (adapt it minimally to accept a message source — it currently reads `sessionRegistry.viewed` — without changing regular-session rendering) plus a slim composer with send and, while working, abort.

**Verify:** store unit tests (event reduction, send/abort wiring, reset on disconnect) green; `npm run check` green.
**Status:** not started

### Step 14: Dashboard + layout (client)

- `client/src/routes/+layout.svelte`: remove the sidebar entirely — the `<aside>`, `FolderList` import, `sidebarOpen` state, mobile overlay, and menu button. Everything else (mobile header, panels, dialogs, `ExtensionStatus`) stays.
- `client/src/lib/components/Dashboard.svelte`: desktop (md+) shows the projects column (`ProjectList`) and the manager chat (`ManagerChat`) side-by-side; mobile shows projects fullscreen with a manager-chat affordance (button/sheet that presents `ManagerChat`).
- `client/src/routes/+page.svelte`: the landing branch (no viewed session) renders `<Dashboard />`.
- Kick off `projectStore.loadProjects()` when the dashboard mounts and the connection is ready (carry over the "loaded for current connection" guard from `FolderList` so reconnects refresh).

**Verify:** `npm run check` green; full server + client suites green; manual smoke at desktop and mobile widths — projects render, manager chat works, opening a session still swaps to the session view.
**Status:** not started

### Step 15: Full verification

- `npm run lint` and `npm run check` clean.
- Full suites: server (`cd server && npx vitest run`) and client (`cd client && npx vitest run`) — the 42 new tests plus the pre-existing 554 server / 542 client all green.
- Boot smoke against a scratch config: dashboard loads, discovery lists real repos, hub create/disband round-trips, manager prompt streams.

**Verify:** all of the above pass.
**Status:** not started
