# Review: Hub Member Representation

**Plan:** `docs/plans/hub-member-representation.md`
**Diff range:** `82ca4d80..HEAD` (pre-test-write `82ca4d80`, pre-implementation `278f371`)
**Date:** 2026-11-06

## Summary

Steps 1–5 and 7–11 were implemented faithfully: the Git worktree adapter, shape-derived membership, both hub layouts, guarded disband mechanics, nested-checkout status, dashboard routing, the manager twin, the dashboard controls, and the docs all match the plan and the approved mock. Two critical problems remain. First, after plan approval the disband semantics changed (DR-085: close idle sessions instead of rejecting on activity) without amending the plan, and the frozen guard tests were rewritten to match — the tests no longer protect the planned contract. Second, disband is dangerously over-eager: a plain repository that merely contains a top-level linked worktree is classified as a worktree hub, and `disband_hub` on such a path deletes the canonical repository, uncommitted files included; the guard also fails open when Git cannot verify a checkout.

## Findings

### 1. Disband deletes any directory that contains a top-level linked worktree, including the canonical repository

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/folder-registry.ts:860-891`, `server/src/folder-registry.ts:376-392`, `server/src/hub-worktrees.ts:145-175`
- **Status:** open
- **Fix:** In `probeHubShapes`, drop worktree members whose `sourcePath` equals or sits inside the probed directory; in `disbandHub`, require `hubPath` to be a known hub row that carries the `.pimote-hub.json` marker.

Every scanned row is probed, and every scanned row is a folder with a `.git` entry. A top-level child with a `.git` file that `git worktree list --porcelain` confirms turns the parent into a "worktree hub": a repo with `git worktree add ./wt`, a dotfiles repo in `~`, or a repo with a top-level submodule. The dashboard then shows "Disband worktree hub…". The `disband_hub` command and `pimote_disband_hub` also accept any `hubPath`, even one that is not a known row. Reproduced: `disbandHub(R)` on a plain repo `R` holding a clean detached `R/wt` and an uncommitted file deleted the whole of `R`, uncommitted file included. A repo with a submodule survives (`git worktree remove` refuses a main working tree) but still shows the hub badge and the disband action, and an attempt closes its idle sessions before it fails.

### 2. The disband guard fails open when Git cannot verify a checkout

- **Category:** code correctness
- **Severity:** critical
- **Location:** `server/src/folder-registry.ts:381`, `server/src/hub-worktrees.ts:172-174`, `server/src/folder-registry.ts:891`
- **Status:** open
- **Fix:** In the disband probe, reject when a child directory has a `.git` file and `inspectMember` returns null or throws; move `isDirty`/`isHeadReachableFromBranchRef` out of `inspectMember` so the probe does not depend on them.

`inspectMember` does not catch failures from `git status` or `rev-list HEAD` — a 30 s timeout on a large checkout, an unborn `HEAD`, a moved source repo, or a broken gitdir pointer. `probeHubShapes` turns any of these into `null`, so the checkout counts as an ordinary directory. The disband guards check members only, so `rm -rf hubPath` then deletes that checkout's uncommitted work. The guard fails open in exactly the cases where Git is unhealthy.

### 3. DR-085 pivot implemented without amending the plan; frozen tests rewritten

- **Category:** plan deviation
- **Severity:** critical
- **Location:** `server/src/hub-activity.test.ts`, `server/src/folder-registry-worktree.test.ts:346-512`, `server/src/manager/types.ts:135-143`, `server/src/hub-activity.ts`, `server/src/folder-registry.ts:866-876`, `server/src/session-manager.ts:1454-1501`
- **Status:** open
- **Fix:** Amend the plan's Interfaces, Step 2, and Step 6 to the DR-085 semantics (or revert to the planned `findBusyPaths` guard), then restore or re-freeze the affected guard tests.

The plan specifies `HubActivityPort.findBusyPaths` as an observation-only guard that checks the hub subtree for active Pimote sessions and external pi processes and rejects. The implementation redefines the port as `closeIdleSessionsAt`, which mutates session state first (closes idle observerless slots through the close lifecycle) and rejects only on what remains. DR-085 records the decision as Accepted, but the plan was never amended. The change also drags in unplanned work: a refactor of the idle reaper's busy rule (`isSlotBusy`, `startIdleCheck`) plus new `session-manager.test.ts` coverage. Test immutability is violated: the Tests section freezes `hub-activity.test.ts` and `folder-registry-worktree.test.ts` at `278f371`, and commit `5f8965e` rewrote both — inverting a settled expectation ("activity rejection wins over dirty state" became "closes an idle observerless session before the remaining guards run").

### 4. Disband deletes non-member hub content with no check

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:891`
- **Status:** open
- **Fix:** Before `rm`, reject when the hub's own repo is dirty or when any child is not a member, the marker, or a generated file.

The guards cover nested worktrees only. The deletion also removes everything else in the hub: the hub repo's uncommitted files, persona `memory.md`, and independent repos cloned into the hub. The probe itself says independent repos "are not members", yet disband deletes them. The UI dialog does not warn about any of this.

### 5. Member identity resolves to the main worktree, not the selected member

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/hub-worktrees.ts:162-166`, `server/src/folder-registry.ts:382-389`
- **Status:** open
- **Fix:** Map the member to the folder it was created from (for example by matching `git rev-parse --git-common-dir` against known folders); do not use the first non-bare entry.

If the selected member is itself a linked worktree or a submodule, the probe reports `target` as the main worktree. If the main repo is bare, `find(!bare)` returns an arbitrary linked worktree. The shape then disagrees with the selected `memberPath`: `removeMember(hub, selectedPath)` fails with "Not a member", and members that resolve to the same target collide in `memberNature`/`memberCheckout` and `find`.

### 6. Worktree member rows carry the source repository's git facts before enrichment

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:502-512`
- **Status:** open
- **Fix:** Build worktree members from the status cached for `worktreePath` (or neutral values) instead of the source `knownRepo`.

The plan's Interfaces section says worktree-hub row facts "describe the nested checkout". The base member row uses the canonical source's cached `branch`/`dirty`/`ahead`/`behind` with `worktreePath` attached; `enrichRows` corrects this only after a status refresh. Before that, `listLazy` rows — including `pimote_find_folders` output, whose schema says these facts belong to the nested checkout — report the source's state as if it were the checkout's. An agent can read `dirty:false` for a dirty worktree and act on it.

### 7. The listing path runs up to three sequential Git processes per nested checkout

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:355-404`, `server/src/hub-worktrees.ts:157-175`
- **Status:** open
- **Fix:** Limit `inspectMember` in the view path to `worktree list` recognition and run the probes with bounded concurrency.

`viewOver` calls `inspectMember` for each child directory with a `.git` file across every scanned row: `worktree list`, then `status --porcelain`, then `rev-list`, in sequence — and the view discards the dirty and reachability results. This breaks `listLazy`'s promise of never blocking on Git probes, in the WS listing and inside each `update`, `addMember`, and `removeMember` (under the mutation lock). Repos with several submodules pay the same cost.

### 8. The activity guard misses pi subagents running inside the hub

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/takeover.ts:94-105`, `server/src/hub-activity.ts:24-33`
- **Status:** open
- **Fix:** For the guard, report every pi process whose cwd is inside the hub, not only root processes.

The scan drops any pi process that descends from pimote or from another pi process, wherever that parent runs. A subagent with cwd inside a hub worktree is invisible to the guard when its parent runs elsewhere (a pimote session's child, or an external pi in another folder). Disband then deletes the directory under a running agent. `findExternalPiProcesses` in takeover also changed: a subagent whose parent pi runs in another folder no longer counts as a conflict.

### 9. A partial disband failure leaves a half-removed hub and a stale view

- **Category:** code correctness
- **Severity:** warning
- **Location:** `server/src/folder-registry.ts:884-893`
- **Status:** open
- **Fix:** Wrap the removal loop and the `rm` in `try/finally` and call `invalidateListing()` and `fireChange({ changedPaths: [hubPath] })` there.

If `remove` fails on worktree N or `rm` fails, earlier worktrees are already gone. No invalidation or change broadcast happens, so clients keep the old member list until some other refresh. The plan requires the remaining shape to stay discoverable for retry; the disk state qualifies, the clients' view does not.

### 10. Frozen `index.test.ts` edited during implementation

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `server/src/index.test.ts:577`
- **Status:** open
- **Fix:** Record the exception in the plan's Tests section.

Commit `9308823` changed the frozen tool-count assertion from 8 to 9. It is a one-line correction the plan itself forced (Step 9 restores `pimote_disband_hub` as the ninth tool, so the pre-written count of 8 contradicted the plan), but it is still an implementation-phase edit to a listed test file.

### 11. DR numbering collision, corrected late, breaks the supersession chain

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `docs/decisions/DR-085-disband-closes-idle-sessions-before-removal.md:12`
- **Status:** open
- **Fix:** Add the DR-063/DR-064 provenance to DR-085's Context.

Commit `c798341` recorded the worktree-hub decision as DR-080 while `DR-080-validated-native-config-writes` already existed; `5f8965e` corrected this by deleting the duplicate and re-recording as DR-085. The supersession chain for DR-063/DR-064 now lives only in the deleted DR-080's git history, since DR-085 cites only DR-080.

### 12. Add-member picker hint placement drifts from the mock

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/HubMembersDialog.svelte:119`
- **Status:** open
- **Fix:** Move the representation hint into the picker rows, or accept the drift.

The approved mock renders the hint per row (`/workspace/web · code → detached worktree`); the implementation shows a single note below the picker ("Code members join as detached worktrees."). The plan intent — show the layout a new code member will use — is met; the per-row affordance from the mock is not.

### 13. A failed worktree rollback leaves stale Git metadata

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/folder-registry.ts:846-849`
- **Status:** open
- **Fix:** After `rm`, run `git worktree prune` in each source.

Two cases leave a prunable entry in the source repo: a `createDetached` that fails midway is never added to `created`, and a swallowed `remove` failure is followed by `rm -rf` of the checkout. Git then reports a missing worktree until someone prunes it.

### 14. The status cache never evicts nested-checkout paths

- **Category:** code correctness
- **Severity:** nit
- **Location:** `server/src/repo-index.ts:419-430`, `server/src/repo-index.ts:614-618`
- **Status:** open
- **Fix:** Evict cache entries for non-listed paths on `invalidateListing`, or after removal and disband.

`enrichStatus` and `refreshRequestedStatus` probe and cache paths the listing does not carry. Paths of removed and disbanded worktrees stay in `statusCache` for the life of the process.

## No Issues

- **Step 1 (Git worktree adapter):** no deviations. Interface, recognition rules, detached creation from source `HEAD`, clean-state and reachability checks, no branch operations, production `execFile` runner with environment protections and timeout.
- **Step 3 (shape-derived membership):** no deviations. Combined symlink/worktree probe, minimal marker grammar, `FolderInfo.hub` for discovered and promised hubs, canonical member `path` plus `worktreePath`, symlink-only `shortcutCount`.
- **Step 4 (both layouts):** no deviations. Marker, detached code worktrees, persona symlinks, member-basename ignoring, generated files, `git init`, full worktree rollback on failure; `hubAgentsMarkdown` describes the selected layout with exact managed lines.
- **Step 5 (representation-aware member edits):** no deviations beyond finding 3's scope. Worktree adds in worktree hubs only, persona always symlink, rollback naming stranded checkouts, dirty rejection before disk change, best-effort managed-line cleanup.
- **Step 6 (guarded disband mechanics):** no deviations apart from findings 1, 2, 3, 4, and 9. Marker-or-worktree eligibility, validate-all-before-remove, single `removedPaths` change, retry-friendly failure.
- **Step 7 (nested checkout status):** no deviations beyond findings 6 and 7. Bounded TTL-cached probes for unlisted checkout paths, `worktreePath ?? path` probing, canonical identity and tags preserved, containment fan-out to the owning hub row.
- **Step 8 (dashboard command routing):** no deviations. `memberRepresentation` forwarding, `disband_hub` routing with removal summary and user-presentable guard errors; pre-written protocol and SDK interfaces intact, SDK twin parity untouched.
- **Step 9 (manager twin):** no deviations beyond finding 10. Schema updates, hub-fact filter, `memberRepresentation` on `pimote_create_folder`, `pimote_disband_hub` with output schema and structured errors, path-based `pimote_update_hub_members`.
- **Step 10 (dashboard controls):** no deviations beyond findings 1 and 12. Compact Symlinks/Detached-worktrees choice with the mock's helper text and live code-member count, reset to symlink, `creationCommand` carries the field for both hub kinds; worktree-only disband menu item with confirmation wording matching the mock, dialog stays open on server guard errors, member rows show representation and nested checkout path, hub identification via the hub fact, stale-hub-fact clearing plus `removedPaths` row removal in the store.
- **Step 11 (docs, DRs, smoke):** no deviations beyond finding 11. Shipped docs, codemap, and glossary updated; DR-062 partially superseded, DR-063/DR-064 superseded; both smoke drivers extended over real dashboard/wire/manager seams with detached creation, membership edits, dirty/observed/unreachable rejections, guarded success, an isolated destructive fixture honored even under `MTMS_ROOT`, and updated PLAN/README.

**Code correctness areas checked and clean:** mutation serialization (all five operations run through `serialized()`), Git argument injection (array `execFile`), symlink-following on deletion, hub and member name traversal, marker parse failure treated as absent, `closeIdleSessionsAt` slot-replacement race, client listener and subscription leaks in the disband dialog, wizard, member dialog, nature icon, and folder store. Manual-test smoke drivers reviewed at low priority; no production risk found.
