# Test Review: Folder model foundation

**Plan:** `docs/plans/folder-model-foundation.md`
**Brainstorm:** `docs/brainstorms/folder-model-foundation.md`
**Date:** 2026-10-04

## Summary

The scanner tests exercise the public folder-model seam with deterministic filesystem fixtures and cover the brainstorm's classification, sparse descent, shortcut recursion, and canonical identity intent. Review resolved a contradictory root fixture, clarified reach paths and finite cycle behavior, and added YAML, shortcut, root, and filesystem-error boundaries. The approved contract now has 43 red cases; all fail only at the intentionally unimplemented scanner, while 694 existing server tests pass.

## Findings

### 1. Pruning fixture contradicted root classification

- **Category:** over-specified
- **Severity:** critical
- **Location:** `server/src/folder-model/folder-model.test.ts:261-274,490-502`
- **Status:** resolved

The original pruning fixture put `.git` directly under a configured root but expected discovery to descend into that root. The brainstorm rejects root exceptions, and `.git` includes its parent. The orchestrator approved normal root classification: removed the contradictory `.git` fixture, added explicit code/persona root coverage, and documented that `.git` pruning during skipped descent is effectively unreachable.

### 2. Skipped-directory cycles and finite back-references were unpinned

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `server/src/folder-model/folder-model.test.ts:432-486`
- **Status:** resolved

The existing shortcut-cycle case did not constrain the back-reference's children, and skipped-directory cycles had no case. The orchestrator approved leaf occurrences for in-progress entries and first-discovery children for completed entries, keeping reports finite and JSON-safe. Added skipped-cycle coverage, leaf and JSON serialization assertions, and reference-identity assertions (`toBe`) instead of merely structural entry equality.

### 3. Filesystem resilience lacked an error contract

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/folder-model/folder-model.test.ts:525-590`; `server/src/folder-model/index.ts:54-70`
- **Status:** resolved

Neither the interface nor tests specified missing/non-directory roots, dangling/looping shortcuts, permission failures, or unreadable marker files. The orchestrator approved local skipping with warnings and healthy-sibling preservation; unreadable markers allow git fallback or continued skipped descent. Added Discovery rule 9, the optional public `onWarning` callback (default `console.warn`), and corresponding boundary tests. Assertions observe warning paths, operations, and errors through the interface without demanding exact message text or call counts.

### 4. YAML marker boundaries were incomplete

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/folder-model/folder-model.test.ts:216-243`
- **Status:** resolved

The plan requires a YAML string `name`, but original fixtures used only plain strings and did not actually include the extra keys claimed in the Tests section. Added quoted strings with punctuation, full agent-definition keys, non-string YAML values, malformed/unclosed blocks, and marker-less git fallback. The orchestrator approved malformed/non-string markers as absent; straightforward string and fallback cases follow the existing interface.

### 5. Occurrence path comments conflicted with reach-path tests

- **Category:** over-specified
- **Severity:** warning
- **Location:** `server/src/folder-model/index.ts:33-41`; `server/src/folder-model/folder-model.test.ts:338-374,414-428`
- **Status:** resolved

The original interface described scan occurrence paths as real paths, while symlink-descent tests asserted walked reach paths. The orchestrator approved the test writer's reach-path interpretation: skipped segments remain inline and shortcut descendants extend the symlink reach path. Updated the architecture and interface comments; completed-entry children retain their first-discovery paths, rather than implying rebasing is required.

### 6. Shortcut boundaries were under-covered

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `server/src/folder-model/folder-model.test.ts:385-412`
- **Status:** resolved

Added already-contracted boundaries: a shared-prefix sibling is outside the included folder, a self-target is not; skipped-context in-tree symlinks are followed and preserve canonical entry identity; pruning still applies below a skipped shortcut target. These are public input/output tests, with no traversal-order or internal-call assertions.

### 7. Broader plan boundaries were not part of this gate

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `docs/plans/folder-model-foundation.md`, Tests / Approved scope
- **Status:** dismissed

The plan includes registry, hub materialization, config, manager reporting, and UI behavior beyond the scanner tests. The orchestrator explicitly approved this gate as scanner-only: those boundary tests are written red-green during implementation against the same Interfaces. Persona artifact memory and manager lifecycle remain outside this increment. The orchestrator also approved `FolderFs.readFile` and the `ProjectUpdatePatch`-shaped `FolderUpdatePatch`; the architecture listings now match the materialized interfaces.

## Validation

- All eight original Discovery rules map to scanner cases; approved root, cycle, reach-path, and failure clarifications are now explicit in the architecture.
- Tests import only the folder-model's public interface and use its injectable filesystem seam; no private helpers or live server behavior are exercised.
- Fixtures use no real filesystem, clock, randomness, network, or filesystem-order assumptions. Assertions involving multiple unordered results sort paths or find entries.
- `npm test --workspace server -- --run`: **43 expected red scanner cases; 694 existing cases pass**. All scanner failures are `not implemented` from the stub, not fixture execution failures.
- `npx tsc -b server --pretty false`: **passes**.
- `codemap.md` is stale for the newly materialized `server/src/folder-model/` ownership; refresh belongs to implementation/cleanup, not this test-only gate.
