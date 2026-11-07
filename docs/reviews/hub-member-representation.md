# Review: Hub Member Representation

**Plan:** `docs/plans/hub-member-representation.md`
**Diff range:** `d8bab61..85482dc`
**Date:** 2026-11-06

## Summary

This follow-up reviews only the fixes after the prior review at `d8bab61`. The fix resolves twelve prior findings, including content-enumeration failure, descendant-process detection, status-probe generation for started probes, equal-basename rejection during creation, and the frozen-test plan exception. Five prior findings remain open, and the fix diff introduces three new correctness issues.

The remaining risks are concentrated in generated-content baselines, equal-basename handling during member additions, status-cache generation around discovery waits, and retry cleanup. The scoped test suites pass, but targeted reproductions confirm these cases.

## Findings

### 1. Canonical repository deletion is blocked

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/folder-registry.ts:401-425,912-922`
- **Status:** resolved
- **Fix:** None needed; retain source-containment rejection and marked, known-hub validation.

Source containment rejection and the marker plus known-hub gate remain intact. A plain repository containing a nested worktree cannot be disbanded as a hub.

### 2. Git verification failures no longer open the deletion guard

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/hub-worktrees.ts:158-182`, `server/src/folder-registry.ts:989-992`
- **Status:** resolved
- **Fix:** None needed; retain recognition-only probing and fail-closed removal validation.

Recognition remains separate from status checks. Unverifiable checkout-shaped children, hub status failures, and removal-validation failures reject disband.

### 3. The DR-085 pivot and guard-test re-freeze are recorded

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `docs/plans/hub-member-representation.md:230-232`, `docs/decisions/DR-085-disband-closes-idle-sessions-before-removal.md:15`
- **Status:** resolved
- **Fix:** None needed; retain the amended plan, DR, and frozen-test exception.

The plan records the accepted activity behavior and the guard-test exception. DR-085 retains the DR-063/DR-064 supersession chain.

### 4. Member edits still replace the generated-content baseline

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:982-984,1149`, `server/src/hub-worktrees.ts:135-148,209-216`
- **Status:** resolved
- **Fix:** Preserve the generated baseline without re-staging unrelated user prose.

Generated files are staged as edit baselines, but `stageGenerated` can re-stage user prose already appended to `AGENTS.md`. The file status becomes an exempt generated entry, so disband deletes the prose. Checking managed markers and member lines does not detect edits outside the managed block.

### 5. `addMember` still bypasses equal-basename identity validation

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:820-825,1126-1149`
- **Status:** resolved
- **Fix:** Apply the same source-identity ambiguity validation to worktree member additions.

Creation now rejects equal-basename main and linked sources before materialization. Adding the linked source to an existing hub still succeeds, creates an undiscoverable checkout, and makes removal by the selected canonical path fail.

### 6. Worktree rows do not report source facts before checkout enrichment

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:541-552`
- **Status:** resolved
- **Fix:** None needed; retain neutral initial facts and checkout-path enrichment.

Worktree rows still begin with neutral Git facts and later enrich from `worktreePath`. No fix change reintroduces source-repository facts.

### 7. Listing recognition does not run sequential status and reachability probes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:397-427`, `server/src/hub-worktrees.ts:158-175`
- **Status:** resolved
- **Fix:** None needed; retain recognition-only probes and bounded concurrency.

Recognition remains one `git worktree list` call per candidate with bounded concurrency. Status and reachability remain outside the listing probe.

### 8. The activity guard includes Pimote-owned descendant pi processes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/takeover.ts:45-105`
- **Status:** resolved
- **Fix:** None needed; retain the destructive subtree enumeration without ancestor exclusion.

The destructive enumeration no longer filters descendants, so Pimote-owned children and external-pi subagents inside the hub count as busy. Root-process filtering remains limited to exact-directory takeover.

### 9. Partial disband invalidates and broadcasts the remaining shape

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:991-1010`
- **Status:** resolved
- **Fix:** None needed; retain invalidation, status eviction, pruning, and the `finally` change event.

The retryable `finally` path still invalidates discovery, evicts status, prunes metadata, and emits the remaining hub shape.

### 10. The frozen manager tool-count test change is recorded

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `docs/plans/hub-member-representation.md:228`
- **Status:** resolved
- **Fix:** None needed; retain the recorded exception.

The plan records the implementation-time eight-to-nine tool-count correction required by the restored manager disband tool.

### 11. DR numbering and supersession provenance are recorded

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `docs/decisions/DR-085-disband-closes-idle-sessions-before-removal.md:15`
- **Status:** resolved
- **Fix:** None needed; retain the DR-063/DR-064 provenance.

DR-085 carries the worktree decision's supersession provenance, and no duplicate worktree DR-080 remains.

### 12. The add-member picker hint still differs from the approved mock

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/HubMembersDialog.svelte:118-119`
- **Status:** dismissed
- **Fix:** Render the representation hint in each picker row.

The mock shows `/workspace/web · code → detached worktree` beside each candidate. The implementation keeps one general note below the picker. The broad requirement is met, but the approved per-row affordance remains different.

### 13. Rollback cleanup prunes stale Git metadata

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-registry.ts:893,1009,1078-1102`, `server/src/hub-worktrees.ts:201-215`
- **Status:** resolved
- **Fix:** None needed; retain `pruneStale` in creation, add, and disband cleanup.

Creation, add rollback, and disband cleanup still prune source repositories. No regression appears in the scoped fix diff.

### 14. Discovery-waiting enrichment can repopulate evicted status

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/repo-index.ts:426-435,893-906`
- **Status:** resolved
- **Fix:** Capture and check the generation before enrichment awaits discovery.

Started probes now check their generation, but `enrichStatus` can wait for discovery and then start or cache a probe under a newer generation after eviction. A reproduction served stale `dirty:true` facts on the next enrichment without another status read.

### 15. Frozen test-file exceptions are recorded in the plan

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `docs/plans/hub-member-representation.md:232`
- **Status:** resolved
- **Fix:** None needed; retain the explicit exception.

The plan now records the implementation-time changes to `hub-worktrees.test.ts` and `folder-registry-worktree.test.ts`, including recognition, identity, generated-content, rollback, and retry coverage.

### 16. Content enumeration failures fail closed

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/folder-registry.ts:963-968`
- **Status:** resolved
- **Fix:** None needed; retain propagated `readdir` errors and the user-presentable verification failure.

An injected `EIO` now retains the hub and its ignored user file. The plan also records this fail-closed behavior.

### 17. Partial-disband retry still rejects registry-produced `.gitignore` changes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:1050-1058`, `server/src/hub-worktrees.ts:135-148`
- **Status:** resolved
- **Fix:** Distinguish registry-produced retry cleanup from user edits independently of `HEAD`-relative status.

Fresh-hub ignore reconciliation works, but after the initial generated files are committed, partial cleanup stages `.gitignore` as `M `. The retry then reports hub-repository changes even though no user edit occurred.

### 18. Creating a second hub from the same repository is rejected as ambiguous

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:823-825`
- **Status:** resolved
- **Fix:** Count only known canonical source candidates, consistent with the shape probe.

Existing hub-child worktrees share their source repository's basename but are not canonical source identities. The new preflight counts those children as competing candidates, so creating a second hub from the same canonical repository now rejects as ambiguous.

### 19. Evicting one path invalidates unrelated status probes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/repo-index.ts:733-742,890-906`
- **Status:** resolved
- **Fix:** Scope eviction generations to the evicted paths, or retire only probes for those paths.

Evicting one path increments a global generation while retaining unrelated in-flight jobs. Those jobs cannot cache their results, and concurrent enrichment of an unrelated checkout returns no facts. Evicting a different checkout reproduced the loss of status for a still-present path.

### 20. Symlink-member removal stages unrelated user changes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:1236`
- **Status:** resolved
- **Fix:** Restrict generated-baseline staging to worktree hubs, matching the add-member path.

Removal calls `stageGenerated` for symlink hubs even though they cannot use the disband baseline. Removing a symlink member staged previously unstaged user prose from `AGENTS.md`.

## Verification

Prior findings **1, 2, 3, 6, 7, 8, 9, 10, 11, 13, 15, and 16** are resolved. Prior findings **4, 5, 12, 14, and 17** remain open. The fix range introduces findings **18, 19, and 20**. No other new plan-adherence or code-correctness findings were identified in the scoped verification.
