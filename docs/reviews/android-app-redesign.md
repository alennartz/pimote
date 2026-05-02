# Review: Android App Redesign

**Plan:** `docs/plans/android-app-redesign.md`
**Diff range:** `01d6594b10ce33c32e03099cbebfc6c7a4601fbb..HEAD`
**Date:** 2026-05-02

## Summary

All 16 planned steps were implemented and the new theme/component layer matches the architecture's interfaces and file layout. No critical defects, but three behavioral warnings stand out: the mute button doesn't actually mute, the in-call header loses the session name outside of `Active`, and the saved server URL doesn't repopulate the Setup field on cold start. The remaining findings are minor spec drifts (missing press-feedback styling, stable-width handling) and small Compose hygiene nits.

## Findings

### 1. Mute button has no effect on audio

- **Category:** code correctness
- **Severity:** warning
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/call/InCallScreen.kt:81, 175-194`
- **Status:** open

The mute button toggles only the local `var muted by remember { mutableStateOf(false) }` — it never calls into `callController` / WebRTC tracks / `AudioManager`. The icon and `AvatarRing` "Muted" badge update, but the mic stays hot. This is a misleading affordance: the user thinks they are muted when they are not. If this is intentional placeholder UI, it should be hidden/disabled; otherwise the action needs to be wired into the call pipeline.

### 2. In-call header drops session name outside `Active`

- **Category:** code correctness
- **Severity:** warning
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/call/InCallScreen.kt:57-67, 121`
- **Status:** open

`sessionDisplayName` only resolves a name when `state is CallState.Active`, so during `Dialing` / `Binding` / `Negotiating` and after `Ended` the title collapses to the literal `"Pimote"`. When a call fails, the user sees `"Pimote"` + the failure reason with no indication of which session it was. Every non-`Idle` `CallState` variant carries a `sessionId`; sourcing the name from that would keep the header meaningful end-to-end.

### 3. Setup field never seeds from the persisted config StateFlow

- **Category:** code correctness
- **Severity:** warning
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/setup/SetupScreen.kt:75`
- **Status:** open

`var origin by rememberSaveable { mutableStateOf(current?.pimoteOrigin ?: "") }` evaluates its initializer once. `current` is a `StateFlow<Settings.Config?>` that almost certainly starts at `null` on cold start and only emits the persisted config after disk I/O completes. By the time the value arrives, `origin` is fixed at `""` and is never updated, so a returning user with a saved URL still sees an empty field. A `LaunchedEffect(current) { current?.pimoteOrigin?.let { if (origin.isBlank()) origin = it } }` (or seeding from an initial value on the ViewModel) closes the gap.

### 4. ContactRow loading spinner is unreachable in practice

- **Category:** plan deviation
- **Severity:** warning
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/contacts/ContactsScreen.kt:166-195`
- **Status:** open

Step 15 specified a post-tap spinner on the row driven by `loadingHandleId`. The current handler does `loadingHandleId = row.handleId` then immediately calls `placeCall(...)` (which returns synchronously — Telecom dispatches the call asynchronously) and clears `loadingHandleId = null` in the same callback frame. Both writes happen before any recomposition, so `isLoading == true` is never observable; the planned per-row loading affordance is effectively dead code. Fix by clearing `loadingHandleId` from a downstream signal (e.g., `CallController.state` leaving `Idle` for the matching `sessionId`) or by removing the unused branch entirely.

### 5. StatusPill collapsed form not aligned to trailing edge

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/components/StatusPill.kt:84-100`
- **Status:** open

Step 6: _"render only the 6dp dot (no text) and align the pill to the trailing edge so it appears near the app bar's trailing area."_ The collapsed branch renders a bare `Box` with no horizontal alignment / `Modifier.align` / `Arrangement.End`, and neither `ContactsScreen` nor `SetupScreen` arranges the pill toward the end. The dot ends up wherever the parent layout puts it.

### 6. ContactRow missing surfacePlus press flash

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/components/ContactRow.kt:38-46`
- **Status:** open

Step 7 specified a 100ms background flash to `surfacePlus` (suggested via `rememberRipple(color = surfacePlus)` or `Surface(onClick = ...)`). Implementation uses bare `Modifier.clickable(onClick = ...)` with the default ripple color.

### 7. PimoteButton missing 16% ink press overlay

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/components/PimoteButton.kt:78-90`
- **Status:** open

Step 10 specified press feedback as _"16% ink overlay + 0.98 scale at 100ms."_ Only the 0.98 scale is implemented; no overlay tint is applied on press.

### 8. PimoteButton width not held stable across loading toggle

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/components/PimoteButton.kt:80-84`
- **Status:** open

Step 10 called for `Modifier.widthIn(min = ...)` or fixed width to prevent layout jump when toggling `isLoading`. Not implemented — when no `leadingIcon` is supplied (default), the width changes between the spinner-present and spinner-absent states.

### 9. PimoteSnackbar inner padding/height differs from spec

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/components/PimoteSnackbar.kt:38-53`
- **Status:** open

Step 12 specified the inner `Snackbar` `modifier = Modifier.padding(16.dp).height(52.dp).border(...)`. Implementation uses `heightIn(min = 52.dp)` (acceptable drift) but drops the inner 16.dp padding — only the host carries it. Total margin is unchanged in practice; noting the spec divergence.

### 10. AvatarRing reimplements `formatCallDuration`

- **Category:** plan deviation
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/components/AvatarRing.kt:175-181`
- **Status:** open

Step 9 introduces `formatCallDuration` in `CallStateHelpers.kt` (and tests it). `AvatarRing` defines its own private `formatDuration` instead of reusing the helper. Output identical, but the helper-extraction intent is muddied and there's now an untested duplicate.

### 11. `CallViewModel` instantiated outside `ViewModelStore`

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/call/InCallScreen.kt:215`
- **Status:** open

`val vm = CallViewModel()` is constructed directly rather than via `viewModels()` / `ViewModelProvider`. On any configuration change the VM is destroyed and rebuilt, restarting `viewModelScope` and re-warming `stateIn` collectors; `durationSeconds` resets (the `LaunchedEffect(isActive)` does this anyway, so user-visible impact is minimal today). Fine while the activity is portrait-locked, but a foot-gun the moment rotation is enabled.

### 12. Contacts row list recomputed on every recomposition

- **Category:** code correctness
- **Severity:** nit
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/ui/contacts/ContactsScreen.kt:97-110`
- **Status:** open

`labelByPath` and `rows` are derived in-line without `remember(projects, sessions)`, so they're rebuilt every recomposition (e.g., `wsState` changes, `refreshing` toggles, snackbar state). Not a correctness bug — `LazyColumn`'s `key = { it.handleId }` keeps row identity stable — but a cheap `remember(projects, sessions) { … }` avoids needless allocation/sorting.

## No Issues

Plan adherence: steps 1–4, 8, 11, 13, 14, and 16 landed cleanly; the inline tests called for in steps 5 and 9 exist and match the planned case lists.

Code correctness: theme tokens, `PimoteOutlinedTextField`, `PimoteSnackbar` (host-level), `StatusPill` auto-collapse logic and `LaunchedEffect` keying, `AvatarRing` infinite-transition lifecycle, `EmptyState`, `cleanStatusReason`, and the unit tests are all clean.
