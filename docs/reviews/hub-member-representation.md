# Review: Hub Member Representation

**Plan:** `docs/plans/hub-member-representation.md`
**Diff range:** `d7c1eb4..9fd6e25`
**Date:** 2026-11-06

## Summary

This follow-up reviews only the fixes after the prior review at `d7c1eb4`. The fixes resolve nine prior findings, including canonical-repository deletion, Git-verification fail-open behavior, stale partial-disband notifications, and stale worktree metadata. Five prior findings remain open, and the fix diff adds three issues: one unrecorded frozen-test mutation, one destructive content-enumeration fail-open path, and one partial-disband retry failure.

The verification passes ran the scoped worktree, registry, takeover, activity, session-manager, and repo-index tests. The targeted suites passed 114 tests.

## Findings

### 1. Canonical repository deletion is blocked

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/folder-registry.ts:401-425,912-922`
- **Status:** resolved
- **Fix:** None needed; retain source-containment rejection and marked, known-hub validation.

`probeHubShapes` rejects a source equal to or inside the probed hub. `disbandHub` now requires both a valid worktree marker and a known hub row. A plain repository containing a nested worktree remains intact and cannot be disbanded.

### 2. Git verification failures no longer open the deletion guard

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/hub-worktrees.ts:158-175`, `server/src/folder-registry.ts:942-955,975-984`
- **Status:** resolved
- **Fix:** None needed; keep recognition separate from status and reachability validation.

Recognition now runs only `git worktree list`. An unverifiable child with a `.git` file blocks disband, while status or reachability failures reject through the removal guards. The scoped tests cover recognition without status probes and corrupted checkout metadata.

### 3. The DR-085 pivot and guard-test re-freeze are recorded

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `docs/plans/hub-member-representation.md:224,243,298`, `docs/decisions/DR-085-disband-closes-idle-sessions-before-removal.md:15`
- **Status:** resolved
- **Fix:** None needed; retain the amended plan, DR, and frozen-test exception.

The plan now records the accepted `closeIdleSessionsAt` behavior and the guard-test re-freeze. DR-085 records the DR-063/DR-064 supersession chain. This resolves the prior mismatch between the implementation, plan, and guard-test expectations.

### 4. Disband still permits some non-member hub content to be deleted

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:939-975`, `server/src/hub-worktrees.ts:128-142`
- **Status:** open
- **Fix:** Require generated entries to have the expected types and protect edited untracked generated files.

Unexpected names, edited `.gitignore`, independent repositories in ordinary names, and tracked generated-file edits now block disband. However, untracked entries named `AGENTS.md` or `memory.md` are exempted by the clean-state check even when their contents changed. Reproductions deleted an edited persona `memory.md` and an independent repository named `memory.md`, including its uncommitted file.

### 5. Worktree member identity remains ambiguous for equal-basename sources

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:403-418`
- **Status:** open
- **Fix:** Preserve the selected source identity, or reject equal candidates before materialization.

Recognition now returns all source candidates and handles distinct basenames correctly. Main and linked checkouts named `project` in different configured roots still produce two exact candidates. Creation succeeds, but the hub reports no members and removal by the selected canonical path fails.

### 6. Worktree rows no longer report source-repository facts before enrichment

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:541-552`
- **Status:** resolved
- **Fix:** None needed; retain neutral initial facts and checkout-path enrichment.

Worktree members now start with neutral Git facts instead of `knownRepo` status. Later enrichment probes `worktreePath`, so rows do not present source status as checkout status.

### 7. Listing recognition no longer runs three sequential Git probes per checkout

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:345,399-407`, `server/src/hub-worktrees.ts:158-175`
- **Status:** resolved
- **Fix:** None needed; retain recognition-only probes and bounded concurrency.

Listing recognition performs one `git worktree list` command per candidate, without status or reachability probes. Candidate recognition is bounded to four concurrent probes.

### 8. The activity guard still misses Pimote-owned descendant pi processes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/takeover.ts:94-105`
- **Status:** open
- **Fix:** Include Pimote descendant processes in the destructive subtree guard.

The guard now includes subagents of external pi processes. It still excludes every descendant of a Pimote process, even when that child has a working directory inside the hub. A live child in the hub produced an empty busy result. Exact-directory takeover retains the same global parent exclusion.

### 9. Partial disband now invalidates and broadcasts the remaining shape

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:991-1012`
- **Status:** resolved
- **Fix:** None needed; retain invalidation, status eviction, pruning, and the `finally` change event.

The removal loop now invalidates discovery, evicts removed checkout status, prunes stale Git metadata, and emits a changed-path event from `finally` after partial failure. The controlled failure produced a reduced membership and a hub change delta.

### 10. The frozen manager tool-count test change is recorded

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `docs/plans/hub-member-representation.md:222`
- **Status:** resolved
- **Fix:** None needed; retain the recorded exception.

The plan records the implementation-time change from eight to nine manager tools. The change matches Step 9, which restores `pimote_disband_hub`.

### 11. DR numbering and supersession provenance are recorded

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `docs/decisions/DR-085-disband-closes-idle-sessions-before-removal.md:15`
- **Status:** resolved
- **Fix:** None needed; retain the DR-063/DR-064 provenance.

DR-085 now states that the deleted DR-080 worktree decision superseded DR-063 and DR-064. No duplicate worktree DR-080 file remains.

### 12. The add-member picker hint still differs from the approved mock

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/HubMembersDialog.svelte:118-119`
- **Status:** open
- **Fix:** Render the representation hint in each picker row.

The approved mock shows `/workspace/web · code → detached worktree` beside each candidate. The implementation shows one general note below the picker. The broad requirement is met, but the approved per-row affordance remains different.

### 13. Failed rollback no longer leaves stale Git worktree metadata

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-registry.ts:893,1009,1078-1102`, `server/src/hub-worktrees.ts:201-203`
- **Status:** resolved
- **Fix:** None needed; retain `pruneStale` in creation, add, and disband cleanup.

Creation rollback, add rollback, and disband cleanup now prune each source repository. A late `createDetached` failure also prunes the source, and the scoped stale-registration test passes.

### 14. An in-flight status probe can repopulate an evicted checkout entry

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/repo-index.ts:719-721,878-885`
- **Status:** open
- **Fix:** Prevent an evicted probe generation from writing its result into `statusCache`.

Removal and disband now call `evictStatus`, but an in-flight probe can write its result after eviction. A reproduction evicted a path during a probe, then observed the removed entry served again with stale `dirty:true` facts. Removed paths can still remain cached, and reused paths can receive stale facts.

### 15. Additional frozen test files changed without a recorded exception

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `server/src/hub-worktrees.test.ts:61-143`, `server/src/folder-registry-worktree.test.ts:85-89,114-125,224-245,386-446,503-517`
- **Status:** open
- **Fix:** Record these implementation-time test changes in the plan, or move the new coverage outside the frozen test files.

The fix range modifies two files listed in the plan's frozen `Test Files` section. The amended plan records exceptions for `index.test.ts` and the DR-085 guard-test rewrite, but not for the interface migrations, identity tests, content tests, recognition tests, and rollback tests in these files. This remains a critical test-immutability deviation.

### 16. Failed content enumeration permits destructive disband

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/folder-registry.ts:942`
- **Status:** open
- **Fix:** Propagate `readdir` failure instead of substituting an empty inventory.

The new content guard treats an unreadable hub as empty. Git does not report unrelated files ignored through `.git/info/exclude`. With one injected `EIO`, disband succeeded and deleted such a file. The guard fails open when the filesystem cannot enumerate the hub.

### 17. A partial disband can make its retry fail

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:959-968,991-1010`
- **Status:** open
- **Fix:** Reconcile generated `.gitignore` entries with surviving members after partial removal.

Disband removes worktrees without removing their ignore entries. If a later removal fails, the retry compares those entries against the reduced membership and reports `.gitignore` as user-edited. A controlled two-member failure reproduced this retry rejection.

## Verification

Prior findings **1, 2, 3, 6, 7, 9, 10, 11, and 13** are resolved. Prior findings **4, 5, 8, 12, and 14** remain open. The fix range introduces findings **15, 16, and 17**. No other new plan-adherence or code-correctness findings were identified in the scoped verification.
