# Test Review: Android — Assistant-callable Pimote projects

**Plan:** `docs/plans/android-assistant-callable-projects.md`
**Brainstorm:** `docs/brainstorms/android-assistant-callable-projects.md`
**Date:** 2026-05-10

## Summary

Tests cover the brainstorm's intent at the pure-function layer: root-segment derivation, the `"<root> <project>"` display-name format, the App Actions desired-set shape (fallback at rank 0, recency-ordered projects, capped), synonym rules, fuzzy-match resolver presence, and shortcut diff semantics. They are at component boundaries (object/static APIs in, plain values out) and contain no Android-binding or non-deterministic behavior. The Android-bound layers (`CallByNameActivity`, `CallByDataRowActivity`, `ShortcutsRunner`, `AndroidShortcutManagerFacade`) are intentionally not JVM-tested — this matches the existing repo convention (`ContactSyncRunner`, `MainActivity`, `InCallActivity`, the contacts trampoline activities, and the contacts facade are likewise untested at this level). Two issues were fixed inline; two were dismissed with explicit reasoning.

## Findings

### 1. `diff` content-equality undercoverage

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `mobile/android/app/src/test/kotlin/com/pimote/android/shortcuts/ShortcutsSyncTest.kt` (diff section)
- **Status:** resolved

The architecture defines `ShortcutsSync.diff` as "diff two lists by shortcutId + content equality". The original tests pinned only one content-difference case — `shortLabel` change triggers an upsert. A trivial implementation that compared just `(shortcutId, shortLabel)` would have passed. Added a test that mutates each of `rank`, `synonyms`, `pimoteUri`, and `capabilityParameter` independently and asserts each mutation triggers an upsert (and no delete). This pins the contract that every `DesiredShortcut` field is content-relevant, which matches the system-side reality: any of those fields affects what `ShortcutManagerCompat.setDynamicShortcuts` pushes.

### 2. No-op `removePrefix` transform in head-of-input-ordering test

- **Category:** wrong abstraction
- **Severity:** nit
- **Location:** `mobile/android/app/src/test/kotlin/com/pimote/android/shortcuts/ShortcutsSyncTest.kt:64-69` (pre-fix)
- **Status:** resolved

The "top maxShortcuts minus one projects are picked from the head of the input ordering" test compared `out.drop(1).map { it.shortcutId }` to `listOf(projectHandleId(...), projectHandleId(...)).map { "project:${it.removePrefix("project:")}" }`. Since `projectHandleId` already returns `"project:<base64>"`, the inner `.map` is a no-op that obscures the assertion's intent. Removed; the comparison is now `listOf(projectHandleId("/work/alpha"), projectHandleId("/work/beta"))` against the actual ids.

### 3. `resolveByFuzzyMatch` only covers exact match and total miss

- **Category:** missing coverage
- **Severity:** nit
- **Location:** `mobile/android/app/src/test/kotlin/com/pimote/android/shortcuts/ShortcutsSyncTest.kt` (resolveByFuzzyMatch section)
- **Status:** dismissed

The resolver is tested with an exact name match (returns the project's pimote URI) and an obviously-non-matching utterance ("zzzqqqxxx", returns null). A trivial `equals`-only implementation would pass these. Dismissed: the brainstorm explicitly flagged the resolver's hit rate as "unknown until tested" — pinning a particular fuzzy threshold or a specific near-match behavior in a unit test would lock in a guess that the brainstorm specifically declined to make. The architecture phrases this loosely as "above an internal threshold". The defensive runtime fuzzy match is a safety net whose calibration belongs in manual testing on real Assistant utterances, not in unit tests at the contract level.

### 4. `CallByNameActivity` 4-step resolution order untested

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/CallByNameActivity.kt` (no test file)
- **Status:** dismissed

The architecture specifies a four-step resolution order in the activity (FALLBACK_PARAMETER → most-recent project; exact shortcut-parameter match; fuzzy-match fallback; defensive MainActivity launch). None of these branches has a JVM unit test. Dismissed for two reasons:

1. The repo convention is that Activities, `Service`s, and the runner classes around them are not JVM-tested — `MainActivity`, `InCallActivity`, the contacts-card trampoline activities, `ContactSyncRunner`, `PhoneAccountRegistrar`'s Telecom integration, and `ConnectionService` implementations all rely on manual / instrumentation testing rather than JVM unit tests. Introducing a single Activity-level harness here for symmetry would be inconsistent and out of scope for this feature.
2. Each branch's underlying decision logic is already covered: most-recent-project resolution is `buildSessionProjectGroups` (covered by existing session tests), exact match is trivial string equality, fuzzy fallback is `ShortcutsSync.resolveByFuzzyMatch` (covered above), and the defensive MainActivity launch is a safety net.

The activity remains a manual-test surface — calling "my pi" via Assistant and confirming the most-recent project gets dialed is the right level of verification.

## Ancillary

- The plan's Tests section names the right test files, the right interface files, and a faithful "Behaviors Covered" enumeration. No drift between plan and reality.
- All `main/` interface stubs throw `TODO("not implemented")`, so the test suite is currently red against them — this is the expected state after the test-write phase.
- `AndroidManifest.xml` and `app/AppContainer.kt` deltas (shortcuts meta-data, two trampoline activity declarations, `AndroidShortcutManagerFacade` + `ShortcutsRunner` wiring) are present and match the architecture. These are configuration/wiring and are not JVM-testable, consistent with project convention.
