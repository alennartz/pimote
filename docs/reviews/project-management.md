# Review: Project Management Redesign

**Plan:** `docs/plans/project-management.md`
**Diff range:** `514e9c43a99d07cc5e5ed8b02d8ab587b221dd5f..HEAD` (pre-test-write baseline; pre-implementation commit `f84bc3a3734a80598d9ea0ec99b36f60b74dc59b` used for the test-immutability check)
**Date:** 2026-02-21

## Summary

The plan was implemented faithfully: all 15 steps are reflected in the diff, the six protected test files are untouched during implementation (the one loader addition is exactly the step-2 planned case), and all planned test behaviors have real assertions. No critical findings. Six warnings — mostly concurrency and partial-failure hardening on the new `ProjectRegistry`/`ManagerService` services, plus one dead-code note — and a handful of nits.

## Findings

### 1. `session-list-groups.ts` machinery dropped, leaving dead code kept alive by its renamed test

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `client/src/lib/session-list-groups.ts:18`, `client/src/lib/components/ProjectList.svelte:300-360`
- **Status:** open

Step 12 says to preserve "per-project session grouping/expansion (`session-list-groups.ts` machinery)". The behavior is preserved (per-project collapse/expand, `MAX_SESSIONS_SHOWN`, per-path session map), but `ProjectList` never imports `buildSessionProjectGroups` — it iterates `projectStore.visibleProjects` and looks up sessions directly. The module is now imported by nothing except its own test, yet step 10 renamed that test's types, cementing a maintained test for dead code into the suite. Either the module should have been deleted or the plan's named machinery kept in use.

### 2. `projects_changed` broadcast and manager tool serve un-enriched `activeSessionCount`, zeroing live indicators in the UI

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/ws-handler.ts:221-231` vs `server/src/ws-handler.ts:1706-1715`; also `server/src/manager/extension.ts:28-33`, `server/src/project-registry.ts:78-99`, `client/src/lib/stores/project-store.svelte.ts:92-94`
- **Status:** resolved

Session-count enrichment lives only in the `list_projects` command case; `broadcastProjectsChanged` and the manager's `pimote_list_projects` tool call `projectRegistry.list()` directly, which always emits `activeSessionCount: 0`. The client's `applyProjectsChanged` replaces the whole projects array, so after any favorite/archive/order/hub mutation (the documented update path — ProjectList comments say "the store updates via the projects_changed broadcast") every green "active" dot in the dashboard disappears until the next full `list_projects`. The manager agent also permanently sees zero counts. This is the doctrine failure of a business operation (count enrichment) living in one caller instead of the module that owns the data — two of three paths already miss it.

### 3. `ProjectRegistry` concurrent mutations race on a shared cached document and a fixed temp filename

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/project-registry.ts:159-176` (update mutates the shared doc before persist), `server/src/project-registry.ts:245-253` (persist uses a fixed `registry.json.tmp`)
- **Status:** open

WS messages are handled fire-and-forget (`server/src/server.ts:269-272`), so two `update_project`/`createHub`/`disband` commands interleave. Both mutate the same cached document object, and both write the same `.tmp` path before renaming: the second `rename` can fail with ENOENT (the first already moved it), making a mutation that actually persisted report failure; interleaved tmp writes are also possible. Additionally, if `persist` throws (disk full), in-memory state keeps the mutation while disk doesn't — divergence until restart. Reachable from a single client action: `moveProject` (`client/src/lib/components/ProjectList.svelte:257-268`) fires one `update_project` per reordered row in parallel.

### 4. `ManagerService.getOrCreate` is not single-flight — concurrent first use orphans a live session

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/manager/service.ts:50-59`; related: `server/src/ws-handler.ts:284-289`
- **Status:** resolved

Two concurrent `manager_prompt` commands for the same clientId both see no existing entry and both await the factory; the second `clients.set` overwrites the first, leaving session A running with no map entry — never disposed (temp dir + runtime leak), its prompt output unbound (the handler's listener re-keys to B). The window is narrow (client clears the draft synchronously) but the server shouldn't depend on that. Related wart: `manager_abort` calls `getOrCreate`, so aborting with no manager creates a full agent session (temp dir, runtime, 30-min idle lifetime) just to abort nothing.

### 5. `createHub` has no rollback for partial failure, and duplicate member basenames fail mid-loop

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/project-registry.ts:179-202`
- **Status:** resolved

After `mkdir`, each `symlink` and the `writeFile` are unguarded. Two member repos with the same basename (e.g. `/a/app` and `/b/app`), or a duplicated `repoPaths` entry, throw EEXIST partway — leaving a half-built hub folder with no registry entry. The leftover folder can't be disbanded (`disband` only accepts registered hub paths) and blocks retry (`Directory already exists`), requiring manual filesystem cleanup. Same partial-state shape if `writeFile` or `persist` fails. Validating basename uniqueness up front and cleaning up on failure would close this cheaply.

### 6. Manager session factory leaks its temp dir when creation fails partway

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/session-manager.ts:845-933`
- **Status:** resolved

`mkdtemp` runs first; `rm(tempDir)` only runs inside `dispose()`. If anything between throws — `createAgentSessionServices` (extension/resource init), `createAgentSessionRuntime`, `setModel` — the temp dir is orphaned and the error propagates to the client as a failed `manager_prompt`. A persistent failure (bad extension, model runtime error) leaks one `/tmp/pimote-manager-*` dir per attempt with no cap. Wrap creation in try/catch that cleans up before rethrowing.

### 7. `create_project` root validation still reads `folderIndex.roots` while the new surface reads `repoIndex.roots`

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `server/src/ws-handler.ts:303` (vs. `server/src/ws-handler.ts:228` for `list_projects`)
- **Status:** resolved

Step 9 routed `create_project` through the creator but left the pre-existing root check on `FolderIndex`. Both arrays are constructed from `config.roots` (`server/src/index.ts:46-48`), so there is no behavioral drift today, but the codebase now has two parallel "configured roots" sources for the same concept that step 9 otherwise unified.

### 8. `ManagerService` constructor takes `context` but never uses it

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `server/src/manager/service.ts:38-47`
- **Status:** resolved

The constructor signature `{ context, factory, options }` matches step 8's wiring call, but `deps.context` is destructured into nothing — the context is only consumed by `createManagerExtension` at the construction site. A required-but-unused parameter; the interface lies about what the service needs, and a reader assumes the service exercises the ports.

### 9. Plan's test-count arithmetic doesn't reconcile (42 vs. 43)

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `docs/plans/project-management.md` (Tests section, "42 red tests")
- **Status:** open

Actual new server tests: 43 (597 − 554); the original per-step verify counts summed to 39. The in-plan HTML comments acknowledge the step-1 (13) and step-4 (14) drift, but the header's "42" matches neither. Cosmetic — behavior coverage itself is complete.

### 10. Commit `3af5ff5` is swept-in unrelated work, not plan work

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/InlineSelect.svelte:1-10`, `client/src/lib/components/InlineSelect.test.ts` (new)
- **Status:** open

This is a mobile-keyboard focus fix for `ask_user` inline questions plus its own new test — it does not belong to this plan and is unrelated client work riding in the range. Not wrong (concurrent changes are treated as intentional); noted so it isn't attributed to the project-management redesign. It touches no plan-protected test file.

### 11. Project-name validation rule duplicated across four sites

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/ws-handler.ts:297`, `server/src/project-registry.ts:58-62`, `server/src/project-sources/builtin.ts:39-41`, `client/src/lib/components/ProjectList.svelte:169-175`
- **Status:** resolved

One business rule ("valid project name") is implemented four times, and it has already drifted: the client rejects `\`, the server-side POSIX checks don't. When the rule changes (e.g. allow spaces, reject control chars), paths will disagree about what the server accepts. One shared validator on the server (client keeps its UX copy) would localize it.

### 12. Registry document load failures and malformed entries brick project management until restart

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/project-registry.ts:43-55` (parseDocument), `server/src/project-registry.ts:231-243` (documentPromise)
- **Status:** resolved

`documentPromise` caches rejection forever, so one transient non-ENOENT read failure (EACCES, EISDIR) fails every project command permanently, even after the file is fixed. And `parseDocument` validates only container shapes: a hub entry without `memberPaths` (hand-edited/corrupt file) makes `hub.memberPaths.map` throw inside `mergedProjects`, failing every `list_projects` until the file is manually repaired. Reset the promise on load failure and validate per-entry shape.

### 13. `RepoIndex.list()` has no in-flight dedupe (TTL stampede)

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/repo-index.ts:88-92` with `108-137`
- **Status:** resolved

On TTL expiry, every concurrent caller runs its own full recursive walk plus a burst of git subprocesses (3 per repo). Multiple clients connecting at once (or `list_projects` racing `broadcastProjectsChanged`) duplicate the whole scan. Harmless but wasteful; a shared in-flight promise is the standard fix.

### 14. `connection.onDisconnected` is a single-assignment slot

- **Category:** code correctness
- **Severity:** nit
- **Location:** `client/src/lib/stores/connection.svelte.ts:75,104,268`; sole consumer `client/src/lib/stores/manager-store.svelte.ts:95`
- **Status:** open

The next store that needs disconnect notification will assign over manager-store's reset, silently reintroducing the stale-manager-transcript bug. A listener set (like `onEvent`) removes the trap.

## No Issues

- **Test immutability:** clean. Of the six protected test files, only `loader.test.ts` changed between `f84bc3a` and HEAD, containing exactly the one planned `.ts`-module case from step 2; the other five are byte-identical. Changed non-protected test files are the mechanical rename/constructor adaptations step 10 anticipates.
- **Plan adherence:** steps 1–11 and 13–15 verified clean in full (walker/TTL/status semantics, jiti wiring, validate-before-mutate, registry document shape and atomic write, pinned toolset, reaper semantics, factory seam, all step-8/9 wiring, complete protocol rename with zero lingering references, store/component/dashboard evolution, lint/check/suites green at 597/566). Behavior coverage: every bullet in the plan's Behaviors Covered list maps to a real test, spot-verified at body level where names were ambiguous.
- **Protocol (`shared/src/protocol.ts`):** clean — renames consistent, unions complete, Android mirror breakage documented in-file. (`RepoInfo.lastActivity` and `ProjectInfo.externalProcessCount` are currently placeholder/unenriched; optional fields, covered by finding 2's enrichment gap.)
- **`repo-index.ts` walker:** clean — depth bound correct, symlinks never followed, source failures isolated, git probes degrade to neutral values, env guarded.
- **`project-sources/`:** clean apart from finding 11 — failure isolation correct, missing dir → empty, builtin creator validates before mutating, `git init` via `execFile` (no shell injection).
- **WS routing for the new command family:** clean — errors funnel through the existing catch-all; root validation on both create paths.
- **Security:** no path traversal (names reject separators and `..`, roots restricted, symlink targets validated index members, `disband` deletes only registry-recorded paths); git via `execFile` without a shell.
- **Manager lifecycle:** reaper interval cleared on shutdown; disconnect cleanup unsubscribes and disposes; client reset-on-disconnect wired.
