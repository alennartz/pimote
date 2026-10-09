# Test Review: Manager Lifecycle

**Plan:** `docs/plans/manager-lifecycle.md`
**Brainstorm:** `docs/brainstorms/manager-lifecycle.md`
**Date:** 2026-10-09

## Summary

The tests cover the brainstorm's intent at component boundaries: persona-folder identity and seeding, manager-exclusive tooling, ordinary persisted sessions, wire-vocabulary cutover, and the composer decision. Two reviewers completed the escalation round; the user approved one decision batch, which this review applied in full. This round found one false-green gate: the assembly-injection assertion passed vacuously on `undefined` under vitest's `toContain`. After the fix, the failure set matches the Red Gate exactly — 30 server and 4 client expected-red tests on stubs and pre-cutover source, all other suites green.

## Findings

### 1. `pimote_create_persona` placement and error contract uncovered

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/manager/persona-tools.test.ts:169-271`
- **Status:** resolved

The first draft tested only the happy path plus one containment failure. The architecture defines a precise placement contract: canonical containment with the scan root itself allowed, symlink escapes rejected, `name` a single nonempty basename segment, and all violations as tool error results — never throws. Per the approved decision batch, added tests for scan-root parents and canonical scan-root aliases (`:202-213`, `:241-253`), symlink escape rejection (`:225-239`), invalid basenames (`:213-223`), sibling paths sharing only the scan-root prefix (`:187-200`), and collision behavior now asserting the user file's bytes are untouched (`:255-271`). All assert no disk effects and no discovery invalidation on rejection.

### 2. Boundary coverage: assembly, ownership, cutover, and composer

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/session-manager-open-session.test.ts:133-181`, `server/src/manager/protocol-cutover.test.ts:15-27`, `client/src/lib/manager-composer.test.ts:4-20`
- **Status:** resolved

The plan's boundary behaviors had no tests. Per the approved decision batch: (a) `session-manager-open-session.test.ts` now loads the manager extension through normal assembly for a `managerRoot` session (`:133-148`) and excludes it from ordinary folder sessions (`:171-182`), with ownership, persistence, and reconnect assertions split into their own test (`:150-169`); (b) `protocol-cutover.test.ts` statically asserts shared source carries no `manager_prompt`, `manager_abort`, or `manager_event` vocabulary — red until cutover, expected; (c) `client/src/lib/manager-composer.ts` carries the pure `managerComposerAction` decision with four stub-red tests covering continue, landing, code session, and the stale-flag-without-view case. Component tests for `ManagerChat.svelte` remain out of scope per the plan; the pure function carries the behavior.

### 3. Assembly-injection assertion was vacuous

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/session-manager-open-session.test.ts:143-145`
- **Status:** resolved

Found in this review round. The injection assertion was `expect(serviceArgs[0]?.resourceLoaderOptions?.extensionFactories).toContain(managerExtensionFactory)`. When nothing is threaded, `extensionFactories` is `undefined`, and vitest's `toContain` passes on `undefined`. The test went green without any injection — a false gate that contradicts the Red Gate ("assembly injection ... red until cutover"). Probed the call path to confirm nothing was threaded. Fixed with `?? []` so the assertion fails until implementation lands. The sibling exclusion test (`:177`) already used `?? []`; `toEqual`, `toContainEqual`, and `not.toContain` all fail on `undefined`, so no other assertion in the changed tests is affected.

### 4. pi-065 ghost-work assertion did not detect tool execution

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/pi-065-newsession.test.ts:70-230`
- **Status:** resolved

The plan's pi-065 contract requires proof that the disposed session executes zero tools. The harness only counted stream calls, so a stale `pi.*` call that silently executed a tool would have passed. Per the approved decision batch, the harness now counts tool executions per generation and asserts `toolCalls === 0` on the disposed generation. The test stays green: it pins the SDK 1.1.0 fail-fast contract, the plan's documented Red Gate exception.

### 5. Seed template identity and omitted-`prompt` template behavior uncovered

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/manager/seed.test.ts:20-41`, `server/src/manager/persona-tools.test.ts:155-167`
- **Status:** resolved

The architecture states the shipped seed template parses as a persona marker (`name: manager`, one-line description) and that `pimote_create_persona` uses the fixed persona template when `prompt` is omitted. Neither behavior was asserted. Per the approved decision batch, `seed.test.ts` now runs the folder-model classifier over the seeded `AGENTS.md` and asserts `nature = persona`, `name = manager`, and a nonempty single-line description (`:27-31`); `persona-tools.test.ts` gained the omitted-`prompt` test asserting template body, `memory.md` link, and stub creation (`:155-167`).

### 6. Filesystem-error propagation and `pimote_list_personas` error semantics uncovered

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/manager/seed.test.ts:76-86`, `server/src/manager/attachment.test.ts:56-64`, `server/src/manager/persona-tools.test.ts:334-345`
- **Status:** resolved

The architecture requires seed and attachment filesystem errors to propagate (boot fails loudly) and `pimote_list_personas` dependency failures to return tool error results. Per the approved decision batch, added the two propagation tests — both green on the throwing stubs and required to stay green on implementation — and the dependency-failure tool-error test with all folder-model ports throwing.

### 7. Over-specified ordering and call-count expectations

- **Category:** over-specified
- **Severity:** warning
- **Location:** `server/src/manager/persona-tools.test.ts:144-153, 307-323`
- **Status:** resolved

The first draft asserted persona rows by array position and demanded exactly one `invalidateListing()` call. Neither is contract: row order is unspecified, and the invalidation count is an implementation detail. Per the approved decision batch, rows are matched with `toContainEqual`/`find` and invalidation asserts `toHaveBeenCalled()` without a count.

### 8. Broken test import for `realpath`

- **Category:** wrong abstraction
- **Severity:** nit
- **Location:** `server/src/manager/persona-tools.test.ts:1-2`
- **Status:** resolved

The first draft imported `realpath` from `node:path`, which does not export it — the suite could not load. Per the approved decision batch, `realpath` now comes from `node/fs/promises`, matching the filesystem identity semantics the contract asserts (canonical paths are real paths).

### 9. Plain-pi sessions at `managerRoot` not covered

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `docs/brainstorms/manager-lifecycle.md` (sharp questions), no test file
- **Status:** dismissed

The brainstorm asks whether the seed front matter misbehaves when a plain pi session opens at `~`. The approved contract defines no observable behavior for this interaction, so no test can assert it at a component boundary. Scoped out of this pull; revisit if the folder model later claims plain-pi compatibility.

### 10. Composer wiring in `ManagerChat.svelte` untested

- **Category:** unplanned scope
- **Severity:** nit
- **Location:** `client/src/lib/manager-composer.ts`, no component test
- **Status:** dismissed

Per the plan and the approved decision batch: component tests stay out of scope; `managerComposerAction` carries the behavior as a pure function. The Svelte surface is a thin caller.

## No Issues

Beyond the findings above, the review is clean. Every brainstorm key decision maps to covered behavior: persona-folder identity and seeding (findings 5, 6), manager-exclusive tooling and attachment rule (findings 1, 2), ordinary persisted sessions with reconnect (finding 2), wire-vocabulary cutover (finding 2), and the composer decision (findings 2, 10). Tests run against the materialized interfaces only. No timing, randomness, network, or filesystem-ordering dependencies remain; the earlier row-ordering and call-count constraints were removed (finding 7).

**Red Gate state at review close (verified):** server 30 failed / 927 passed, client 4 failed / 796 passed. Every failure is an expected-red stub or pre-cutover assertion; `pi-065-newsession.test.ts`, the ownership/reconnect suite, the exclusion test, and the filesystem-propagation tests are green. `npm run check` (svelte-check + server and shared tsc) and `eslint .` pass.
