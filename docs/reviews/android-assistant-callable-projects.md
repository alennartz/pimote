# Review: Android — Assistant-callable Pimote projects

**Plan:** `docs/plans/android-assistant-callable-projects.md`
**Diff range:** `e44e343b42f6c625c54cd4ed429f0f966c46d54f..HEAD` (single commit `a4db490`)
**Date:** 2026-05-10

## Summary

The plan was implemented faithfully. All 13 steps are reflected in the diff with reasonable adaptations (case-insensitive `capabilityParameter` matching, an additional empty-`participantName` guard treated like the fallback path). Test files were not modified during implementation. A handful of small, low-severity correctness and consistency observations are noted below — none block shipping.

## Findings

### 1. `ShortcutsSync.diff` semantics don't compose with the facade's full-replace `setDynamicShortcuts`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/ShortcutsSync.kt:97-106`
- **Status:** open

`diff()` returns `toUpsert` containing only entries whose content changed (and entries newly added), excluding content-equal entries that should still exist. `ShortcutManagerFacade.setDynamicShortcuts(...)` replaces the full set. Anyone wiring `diff` through to the facade as `setDynamicShortcuts(ops.toUpsert)` would inadvertently delete unchanged shortcuts. The runner sidesteps the issue by calling `setDynamicShortcuts(desired)` directly when `desired != existing` (Step 9), so `diff` is currently only exercised by its unit tests. The plan asked for `diff` in this shape, but the function as exported is a footgun for any future caller. Either drop `diff` (runner doesn't need it) or document that `toUpsert` must be merged with content-equal `existing` entries before being passed to the facade.

### 2. `CallByNameActivity` fallback path doesn't fall through to fuzzy/MainActivity when projects list is empty

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/CallByNameActivity.kt:46-55`
- **Status:** open

Plan Step 10 says: when `participantName == FALLBACK_PARAMETER` and the project list is empty, "show a toast 'No projects available' and finish." Implementation matches, but it also routes empty `participantName` through the same branch (treating it as fallback). That's a defensible adaptation — Assistant occasionally fulfills with no parameter — but it diverges from the plan's stricter `==` test and means an empty-participant call with zero projects ends in a toast rather than the defensive MainActivity launch the plan reserves for non-fallback misses. Mention either way; the user-facing result is comparable.

### 3. `getDynamicShortcuts` round-trip silently coerces missing labels to empty strings

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/AndroidShortcutManagerFacade.kt:80-82`
- **Status:** open

`info.longLabel?.toString() ?: ""` and `extras?.getString(EXTRA_CAPABILITY_PARAMETER) ?: ""` coerce missing extras to empty strings rather than surfacing the corruption. In normal operation we always set both, so the round-trip is safe. If a third party (or a future `ShortcutManagerCompat` semantic shift) ever drops an extra, the diff will silently differ from `desired` (capabilityParameter `""` vs. e.g. `"repos pimote"`), causing a permanent reconcile loop on every debounce tick. A debug-time `L.w` if `extras` is null or the keys are missing would catch this.

### 4. `resolveByFuzzyMatch` rejects multi-token utterances against single-token candidates at the score threshold

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/ShortcutsSync.kt:128-156`
- **Status:** open

Score is `shared.size / max(utteranceTokens, candidateTokens)` with a strict `> 0.5` cutoff. Utterance "repos pimote" against a project with `folderName = "pimote"` and no root yields one shared token over two utterance tokens = 0.5, which fails the strict threshold. The unit tests don't exercise this case (they cover only exact-match and total-mismatch), so behavior is technically within spec, but Assistant is reasonably likely to produce two-word utterances against single-word project names. Consider `>= 0.5`, or weighting candidate matches more leniently.

### 5. `CallByNameActivity` exact-match relies on `capabilityParameter` (the shortLabel), not synonyms

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/CallByNameActivity.kt:60-67`
- **Status:** open

Assistant binds `call.participant.name` against the synonym list (e.g. `["pimote", "repos pimote"]`) but may pass back any of those values. The exact-match step compares against `capabilityParameter`, which equals the canonical `shortLabel` (e.g. `"repos pimote"`). When Assistant returns `"pimote"`, exact-match fails and the request leans on `resolveByFuzzyMatch`, which currently scores `1.0` for that case and resolves correctly. Combined with finding 4, the fuzzy fallback is doing more work than the plan implied. Worth either widening exact-match to scan `synonyms` (cheap, deterministic), or noting in a comment that the fuzzy stage is the canonical synonym→project resolver.

## No Issues

- **Test immutability:** No changes to `*Test.kt` files between `pre-implementation-commit` (`e44e343`) and HEAD. Verified.
- **Plan adherence (overall):** Each of the 13 steps is reflected in the diff. Step 1 (`rootSegmentOf`), Step 2 (`ContactsSync` display-name format), Steps 3–6 (`ShortcutsSync` pure functions), Step 7 (`CallByPimoteUri.placeCall`, mirroring `ContactsScreen.placeCall` with `Uri.fromParts(scheme, ssp, null)`), Step 8 (`AndroidShortcutManagerFacade` with PersistableBundle round-trip), Step 9 (`ShortcutsRunner` with debounce + reconcile), Steps 10–11 (trampoline activities), Step 12 (`PimoteApp` wiring `shortcutsRunner.start()`), Step 13 (`tools/manual-test/PLAN.md` journey 9) all land as planned.
- **No unplanned scope:** The diff stays within the modules the plan named.
