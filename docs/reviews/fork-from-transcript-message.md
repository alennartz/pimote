# Review: fork-from-transcript-message

**Plan:** `docs/plans/fork-from-transcript-message.md`
**Diff range:** `86a8a4c..a3d499d`
**Date:** 2026-10-31

## Summary

The scoped fix commit resolves the prior correctness findings: deep `get_tree` responses use iterative serialization, tree caches invalidate after turns, draft reads survive resync, and the UI race and layout fixes are in place. One approved-mock detail remains out of sync: branch rows still display a `branch` metadata chip even though the mock requires indentation alone to convey structure. Targeted client and server tests pass, `npm run check` reports no diagnostics, and the prior test-immutability and unrelated-scope findings remain explicitly dismissed.

## Findings

### 1. Branch metadata chip still violates the approved explorer mock

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `client/src/lib/components/BranchExplorer.svelte:263`
- **Status:** resolved
- **Fix:** Remove the `branch` chip or update the approved interaction contract to include it.

The approved explorer mock says branch structure reads from indentation alone and has no metadata on rows. The implementation still renders `<span class="branch-chip">branch</span>` for every branch point. The fix commit corrected custom-compaction visibility and menu dismissal, but it did not remove this remaining mock drift.
