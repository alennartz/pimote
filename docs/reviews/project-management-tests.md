# Test Review: project-management

**Plan:** `docs/plans/project-management.md`
**Brainstorm:** `docs/brainstorms/project-management.md`
**Date:** 2026-09-28

## Summary

The tests cover the brainstorm's intent well: repo index ⊥ projects, bounded recursive discovery, pluggable sources/creators, hub creation with index-validated members, favorites/order/archive, and the per-connection ephemeral manager lifecycle are all contracted at component boundaries with real fs/git fixtures and injectable clocks — no non-determinism, no internals-reaching. Gaps found: the built-in mkdir/git-init creator was named in the plan but never materialized or tested (architecture gap, closed with approval), the manager toolset had no behavioral contract (pinned with approval), and several under-specified behaviors (AGENTS.md content, manual ordering, hub curation, hub-name collision, missing root) are now pinned. The approved contract is 42 red tests across 6 files; the pre-existing server suite (554) stays green.

## Findings

### 1. Built-in mkdir/git-init creator uncontracted

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `docs/plans/project-management.md` (New Modules named it; no interface file or test existed)
- **Status:** resolved

The plan's New Modules section named a built-in filesystem-walker source and mkdir/git-init creator, and the brainstorm lists "create project (root + name → mkdir + git init)" as a must-preserve sidebar feature — but the test-write phase materialized neither an interface stub nor tests for the creator (the built-in source is covered via `RepoIndex`). Architecture gap traced to the plan, not the test writer. User approved closing it here: added `server/src/project-sources/builtin.ts` (`createBuiltinCreator(): ProjectCreator` stub) and `server/src/project-sources/builtin.test.ts` — descriptor form (`root` + `name`), mkdir + git init, target-exists rejection touching nothing.

### 2. Manager toolset had no behavioral contract

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/manager/extension.ts`
- **Status:** resolved

`createManagerExtension` was stubbed with no test file, and the tool surface (names, params, port routing) was defined nowhere — yet the brainstorm makes the toolset the manager's core value. User approved the minimal contract: `server/src/manager/extension.test.ts` pins exactly the three listing tools (`pimote_list_projects`, `pimote_list_repos`, `pimote_list_sessions`, empty params) and asserts each routes through the injected `ManagerToolContext` ports. Session create/manage tools, search parameters, and output shaping are explicitly deferred to implementation planning (noted in the plan) since their ports don't exist yet. The same deferral note covers the real session factory's ephemeral properties (`SessionManager.inMemory`, temp cwd, event-mapping reuse), which live behind `ManagerSessionFactory` and get exercised when the factory is implemented.

### 3. Hub AGENTS.md assertion too weak

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/project-registry.test.ts` (hub AGENTS.md test)
- **Status:** resolved

The test asserted only that the generated `AGENTS.md` is non-empty, but the brainstorm defines its purpose: state that each symlinked subdir is a sub-project whose own `AGENTS.md` must be consulted. Fixed autonomously: the test now asserts the file names each member repo and mentions `AGENTS.md`, without pinning exact wording.

### 4. Manual ordering never behaviorally tested

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/project-registry.test.ts` (`ProjectRegistry.list()`)
- **Status:** resolved

The interface comment pins "manual ordering; absent = name sort", but tests only checked that an `order` value round-trips — not that `list()` sorts by it. Fixed autonomously: added a test asserting the default listing is name-sorted and that `order` overrides reorder it (ascending, the natural reading of the interface).

### 5. Curation overrides untested for hub projects

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/project-registry.test.ts` (`ProjectRegistry.list()`)
- **Status:** resolved

Only single-repo curation was tested; the brainstorm's project-level archive applies to projects generally, and hub flags may take a different storage path than single-repo overrides. Fixed autonomously: added a test applying `favorite`/`archived` to a hub project and asserting the merged listing reflects it.

### 6. createHub with an existing target folder — behavior unspecified

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/project-registry.test.ts` (`ProjectRegistry.createHub()`)
- **Status:** resolved

No contract for `createHub` when `root/<name>` already exists — reject vs. overwrite vs. reuse was a real fork. User approved: reject with a clear error, create nothing, consistent with the member-validation failure path. Test added pinning rejection and that the existing hub listing is untouched.

### 7. Missing configured root boundary untested

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `server/src/repo-index.test.ts` (recursive discovery)
- **Status:** resolved

A configured root that doesn't exist (e.g. unmounted volume) had no specified behavior. Fixed autonomously: added a tolerance test — `list()` resolves and still reports repos from the remaining roots.

### 8. In-tree symlink semantics unpinned

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `server/src/repo-index.test.ts` (symlink test)
- **Status:** dismissed

Only outside-pointing symlinks are covered; what the walker does with an in-tree symlink is entangled with the hub-folder exception (hubs are full of in-tree symlinks that must be followed). The plan already defers that exception to implementation (it depends on the generated-AGENTS.md marker convention hub creation defines). Dismissed as subsumed by that existing deferral rather than escalated — no new decision required.

## No Issues

Beyond the findings above, validation was clean: every brainstorm key decision maps to test behaviors; all tests exercise only materialized interface stubs through their public surface; real fs/git fixtures are deterministic (injectable clocks for both TTLs and the reaper, pinned default branch, guarded git env); assertions stay satisfiable by any correct implementation (exact-order assertions appear only where the interface pins the ordering). The client surfaces (Dashboard, ProjectList, ManagerChat, stores) and the `FolderInfo`→`ProjectInfo` physical rename are explicitly deferred in the plan and were not treated as gaps.
