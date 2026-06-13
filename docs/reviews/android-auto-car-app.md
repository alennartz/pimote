# Review: Android Auto Car App — Project/Session Call Picker

**Plan:** `docs/plans/android-auto-car-app.md`
**Diff range:** `8df1e3f99ccfc38370e698da51351c8851d420dd..c95f19c` (impl); test-write baseline `13d9e60`
**Date:** 2026-06-12

## Summary

The plan was implemented faithfully and completely. All six steps landed as specified:
the `androidx.car.app` 1.7.0 dependencies, the three pure `CarRowModels` helpers, the
`automotive_app_desc` resource, the four `CarAppService`/`Session`/`Screen` framework
shells, and the manifest wiring. `make android-test` and `make android-build` are both
green; the `CarRowModelsTest` suite passes and was not modified during implementation.
The pure seam is well-factored and matches its contract. Findings are minor — three nits
around small duplication/shape issues in the framework glue, plus one note about an
unrelated change that rode along in `build.gradle.kts`.

## Findings

### 1. `buildRow` duplicated verbatim across both screens

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/car/ProjectListScreen.kt:93-98`, `ResumeSessionsScreen.kt:55-60`
- **Status:** resolved

Both screens carry a byte-identical private `buildRow(row: CarRow): Row` (title +
`addText(subtitle)` + `setOnClickListener { placeCarCall(...) }`). "Turn a `CarRow` into a
tappable car `Row`" is one business operation reachable two ways — the exact drift hazard
coding-principle #6 warns about (one screen gets a row tweak the other doesn't). The shared
`placeCarCall(...)` helper was already extracted; `buildRow` should have been too (it can sit
next to `placeCarCall` as a `CarRow.toCarRow()`-style helper or a top-level function). Low
risk today because they're identical, but they will drift.

### 2. `placeCarCall` is a `Screen` extension that ignores its receiver

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/car/ProjectListScreen.kt:106-109`
- **Status:** resolved

`internal fun Screen.placeCarCall(carContext: CarContext, dialUri: String)` never references
its `Screen` receiver — `carContext` is passed explicitly. The receiver is dead weight that
implies a dependency on the screen that doesn't exist. A plain top-level function taking
`(carContext, dialUri)` says exactly what it is. Trivial, but the misleading shape is worth a
pass.

### 3. `placeCall` boolean result is dropped; "Calling…" toast shows unconditionally

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/car/ProjectListScreen.kt:106-109`
- **Status:** open

`CallByPimoteUri.placeCall(...)` returns a `Boolean` success flag, but `placeCarCall` ignores
it and always shows `CarToast` "Calling…". A rejected dispatch still tells the user the call is
placing. The plan explicitly delegates dispatch outcome to `CallController` and only asks for a
transient toast, so this is in-spec, not a defect — noted only because the dropped return value
silently hides a failure signal that a future iteration may want to surface.

## No Issues

- **Plan adherence:** no significant deviations. Every step's work is present and matches
  intent; `CarRowModels` ordering/subtitle/dialUri/truncation/precedence logic implements the
  pinned contracts exactly. Lexical string comparison of `modified` for recency ordering is
  the plan-sanctioned approach (shared with `SessionListGroups`/`ContactsSync`, which rely on
  zulu-normalized ISO-8601 timestamps).
- **Test immutability:** `CarRowModelsTest.kt` is unchanged between the pre-implementation
  commit and HEAD. The `CarRowModels.kt` interface carried three `TODO` stubs at the baseline,
  now implemented — a legitimate fill-in of the stubbed seam.
- **Coding principles:** the reactive collectors in both screens correctly follow principle #4
  — each captures the final `this` (`Screen`) for `invalidate()` and reads the container as a
  local val, never a reassignable slot. `CarRowModels` is pure and returns values (#1).

## Note (not a finding)

`build.gradle.kts` also added an unrelated `AUDIO_TELEMETRY` `buildConfigField` (debug-on,
release-off) with no connection to the car-app plan. Per the repo's concurrent-changes
convention this is treated as intentional; flagged only so it isn't mistaken for part of this
feature.
