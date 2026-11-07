# Review: Hub Member Representation

**Plan:** `docs/plans/hub-member-representation.md`
**Diff range:** `85482dc..c5b7cab`
**Date:** 2026-11-06

## Summary

This follow-up reviews only the fixes after the prior review at `85482dc`. The fixes resolve seventeen prior findings, including normal generated-content baselines, equal-basename additions, partial-disband retry reconciliation, canonical-source reuse across hubs, unrelated status-probe eviction, and symlink-hub staging. Three prior findings remain open, and the fix diff introduces three new correctness issues.

The remaining risks are ignored generated files, the final result race in status enrichment, and the approved picker hint. New risks cover an excluded-but-selected source identity, stale baselines after persona removal, and unbounded per-path generation tombstones. The scoped affected suites pass 126 tests, but targeted reproductions confirm these cases.

## Findings

### 1. Canonical repository deletion is blocked

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/folder-registry.ts:434,948-953`
- **Status:** resolved
- **Fix:** None needed; retain source-containment rejection and marked, known-hub validation.

Containment rejection and the marker plus known-hub gate remain intact. A plain repository containing a nested worktree cannot be disbanded as a hub.

### 2. Git verification failures no longer open the deletion guard

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/hub-worktrees.ts:211-253`, `server/src/folder-registry.ts:1014`
- **Status:** resolved
- **Fix:** None needed; retain recognition-only probing and fail-closed removal validation.

Recognition remains separate from removal validation. Unverifiable children and Git validation failures still reject disband.

### 3. The DR-085 pivot and guard-test re-freeze are recorded

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `docs/plans/hub-member-representation.md:230-232`
- **Status:** resolved
- **Fix:** None needed; retain the amended plan, DR, and frozen-test exception.

The accepted activity behavior, guard-test exception, and DR supersession chain remain documented.

### 4. Ignored generated files still bypass their persisted baseline

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/hub-worktrees.ts:185-199`, `server/src/folder-registry.ts:994-1007,1039`
- **Status:** resolved
- **Fix:** Check generated-content baselines independently of Git's ignored or tracked state.

Normal appended prose now blocks disband after a member edit. However, baseline comparison runs only for files present in Git status. Adding `AGENTS.md` to `.git/info/exclude` hid the edited file, and disband deleted its user prose.

### 5. Equal-basename member additions are rejected

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:1148-1156`
- **Status:** resolved
- **Fix:** None needed; retain the add-time ambiguity guard.

Additions now apply the same known-source and equal-basename guard as creation. The standard equal-basename case rejects without creating an undiscoverable checkout.

### 6. Worktree rows do not report source facts before checkout enrichment

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:541-552`
- **Status:** resolved
- **Fix:** None needed; retain neutral initial facts and checkout-path enrichment.

Neutral initial facts and checkout-path enrichment remain unchanged.

### 7. Listing recognition does not run sequential status and reachability probes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:408-438`, `server/src/hub-worktrees.ts:211-253`
- **Status:** resolved
- **Fix:** None needed; retain recognition-only probes and bounded concurrency.

Recognition remains one bounded `git worktree list` probe without status or reachability checks.

### 8. The activity guard includes Pimote-owned descendant pi processes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/takeover.ts:45-105`
- **Status:** resolved
- **Fix:** None needed; retain destructive subtree enumeration without ancestor exclusion.

The destructive enumeration still includes Pimote-owned descendants and external-pi subagents. Exact-directory takeover keeps its root filtering.

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

The plan still records the implementation-time eight-to-nine tool-count correction.

### 11. DR numbering and supersession provenance are recorded

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `docs/decisions/DR-085-disband-closes-idle-sessions-before-removal.md:15`
- **Status:** resolved
- **Fix:** None needed; retain the DR-063/DR-064 provenance.

DR-085 retains the worktree decision's supersession provenance, and no duplicate worktree DR-080 remains.

### 12. The add-member picker hint still differs from the approved mock

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/HubMembersDialog.svelte:118-119`
- **Status:** dismissed
- **Fix:** Render the representation hint in each picker row.

The mock shows `/workspace/web · code → detached worktree` beside each candidate. The implementation still shows one general note below the picker.

### 13. Rollback cleanup prunes stale Git metadata

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-registry.ts:925-930,1163-1192`, `server/src/hub-worktrees.ts:201-215`
- **Status:** resolved
- **Fix:** None needed; retain `pruneStale` in creation, add, and disband cleanup.

Creation, add rollback, and disband cleanup still prune source repositories. No regression appears in the scoped fix.

### 14. An invalidated enrichment can return replacement-generation facts

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/repo-index.ts:436-451`
- **Status:** resolved
- **Fix:** Recheck each captured token before collecting the final cached result.

Discovery-wait and cache-write races are fixed, but final result collection does not recheck its token. If eviction and a replacement probe occur during the wait, the old caller reads replacement facts and can apply them to an old row with a different canonical identity.

### 15. Frozen test-file exceptions are recorded in the plan

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `docs/plans/hub-member-representation.md:232`
- **Status:** resolved
- **Fix:** None needed; retain the explicit exception.

The plan records the implementation-time changes to `hub-worktrees.test.ts` and `folder-registry-worktree.test.ts`, including recognition, identity, generated-content, rollback, and retry coverage.

### 16. Content enumeration failures fail closed

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/folder-registry.ts:977-983`
- **Status:** resolved
- **Fix:** None needed; retain propagated `readdir` errors and the user-presentable verification failure.

Enumeration errors still reject disband and retain the hub and its ignored user files.

### 17. Partial-disband retry reconciles generated `.gitignore` changes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:1050-1058`, `server/src/hub-worktrees.ts:257-293`
- **Status:** resolved
- **Fix:** None needed; retain persisted baselines that distinguish registry cleanup from user edits.

After generated files are committed, controlled partial failure and retry now reconcile the removed member's ignore entry without reporting a registry-produced change as user dirtiness.

### 18. A second hub can reuse one canonical repository

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:224-229,831-840`
- **Status:** resolved
- **Fix:** None needed; retain canonical-source candidate filtering.

Nested worktree children owned by marked hubs no longer count as competing source identities. The scoped test confirms that a second hub can use the same canonical repository.

### 19. Evicting one path no longer invalidates unrelated probes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/repo-index.ts:745-756,902-920`
- **Status:** resolved
- **Fix:** None needed; retain global plus per-path status tokens.

Path-scoped tokens preserve unrelated in-flight probe results when one checkout is evicted.

### 20. Symlink-hub removal no longer stages unrelated user changes

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:1268-1269`
- **Status:** resolved
- **Fix:** None needed; retain the no-staging path for symlink hubs.

Removing a member from a symlink hub no longer stages previously unstaged prose.

### 21. An excluded selected source identity is silently replaced

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:224-229,1148-1156`
- **Status:** resolved
- **Fix:** Reject an excluded selected source before creating its checkout, or preserve that selected identity.

A hub child explicitly configured as a root remains a selectable folder. The candidate filter excludes that selected checkout, but `addMember` accepts it and reports the main repository instead. Removal by the selected path then fails.

### 22. Removing a persona symlink leaves a worktree hub baseline stale

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:1268-1269`, `docs/plans/hub-member-representation.md:283-286`
- **Status:** resolved
- **Fix:** Update baselines for every member removal in a worktree hub without staging files.

`removeMember` updates a baseline only when the removed member is a worktree. Persona members are symlinks by contract, but their removal still changes generated `.gitignore`. Disband then rejects the registry-produced change as uncommitted hub content.

### 23. Per-path generation tombstones grow without bound

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/repo-index.ts:329,745-756`
- **Status:** resolved
- **Fix:** Retire generation tokens without retaining removed path keys after affected requests settle.

Each evicted checkout adds a permanent `statusPathGenerations` entry. Ordinary hub mutations invalidate listings without clearing the map, so a long-lived server retains every distinct disposable checkout path.

## Verification

Prior findings **1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 13, 15, 16, 17, 18, 19, and 20** are resolved. Prior findings **4, 12, and 14** remain open. The fix range introduces findings **21, 22, and 23**. No other new plan-adherence or code-correctness findings were identified in the scoped verification.
