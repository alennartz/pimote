# Plan: Android contacts screen — PWA session list parity

## Context

The Android in-app contacts screen (`mobile/android/app/src/main/kotlin/com/pimote/android/ui/contacts/ContactsScreen.kt`) currently shows a flat list of project rows followed by session rows, with only `name` / `archived` available per session. The PWA shows a richer, grouped list: each project as a header followed by its sessions sorted by recency, with a display-name fallback chain (name → first-message excerpt → `Session <id-prefix>`), a cwd hint, message count, and a relative-time stamp. The wire protocol already carries the richer fields on `SessionInfo`; the Android `SessionMeta` strips them. This plan plumbs them through and ports the grouping + display logic to Kotlin.

The system contacts-DB layer (sync into `ContactsContract`) is unaffected — it remains projects-only.

No brainstorm — direction was given directly.

## Architecture

### Impacted Modules

- **Android Client / session** (`mobile/android/app/src/main/kotlin/com/pimote/android/session/`)
  - `SessionMeta` — gains `modified: String`, `created: String`, `messageCount: Int`, `firstMessage: String?`, `cwd: String?`. Existing fields (`sessionId`, `folderPath`, `folderName`, `name`, `archived`) keep their meanings.
  - `reduceSessionEvent` — signature changes to take a clock injection `now: () -> String` (ISO-8601 UTC). `session_opened` seeds `created = modified = now()`, `messageCount = 0`, `firstMessage = null`, `cwd = null`. `session_replaced` copies the rich fields from the old row verbatim. `session_renamed` and `session_archived` reductions are unchanged in behavior. The clock is the only new input — the reducer remains pure in the sense of "same inputs ⇒ same outputs".
  - `SessionRepositoryImpl.refresh` and `refetchFolder` — populate the new `SessionMeta` fields from `SessionInfo` (already on the wire). `start()` passes a real-clock `now` lambda (`java.time.Instant.now().toString()`) into the reducer.

- **Android Client / ui/contacts** (`ui/contacts/ContactsScreen.kt`)
  - Replaces the flat list with a grouped `LazyColumn`: one section per project, sorted by `lastModified` (newest first), each section preceded by a project header that doubles as the project's call action. Sessions inside a section are sorted by recency. Empty projects are omitted (matches PWA `buildSessionProjectGroups`).
  - The existing `ContactRow` component is reused for both project and session rows (project rows pass `kind = ContactKind.Project`, session rows pass `kind = ContactKind.Session`).
  - The placeCall path is unchanged — taps still resolve to `pimote:project:<base64>` or `pimote:session:<id>` URIs.
  - Pull-to-refresh / Refresh button / WS state pill / loading spinner / snackbar — all preserved.

- **Android Client / contacts** (`contacts/`)
  - Untouched. `ContactsSync.computeDesiredContacts` and the system-contact sync layer continue to work off `name` + `archived` only. No changes to the contacts DB story.

### New Modules

- **Android Client / session/SessionListGroups** — pure helper module under `mobile/android/app/src/main/kotlin/com/pimote/android/session/SessionListGroups.kt`. Mirrors `client/src/lib/session-list-groups.ts`. Owns:
  - `data class SessionProjectGroup(project: ProjectMeta, sessions: List<SessionMeta>, lastModified: String)`
  - `fun buildSessionProjectGroups(projects: List<ProjectMeta>, sessions: List<SessionMeta>): List<SessionProjectGroup>`

  Drops empty-session projects, sorts sessions newest-first within each project, sorts groups by their newest session's `modified`. Pure function, fully unit-testable.

- **Android Client / session/SessionDisplay** — pure helper module under `mobile/android/app/src/main/kotlin/com/pimote/android/session/SessionDisplay.kt`. Mirrors `SessionItem.svelte`'s display fallbacks plus `format-relative-time.ts`. Owns:
  - `fun sessionDisplayName(session: SessionMeta): String` — `name?.takeIf { it.isNotBlank() } ?: firstMessage?.let { truncate(it, 60) } ?: "Session ${sessionId.take(8)}"`.
  - `fun shortenCwd(cwd: String): String` — last two path segments with `…/` prefix when truncated; returns the input verbatim when it has ≤ 2 non-empty segments.
  - `fun cwdLabelFor(session: SessionMeta, folderPath: String): String?` — returns `shortenCwd(cwd)` when `cwd != null && cwd != folderPath`, else null. Matches PWA's "show cwd only when distinct from the folder it belongs to" rule.
  - `fun formatRelativeTime(isoTimestamp: String, nowMillis: Long): String` — pure version of `format-relative-time.ts`. `< 60s ⇒ "just now"`, `< 60m ⇒ "Nm ago"`, `< 24h ⇒ "Nh ago"`, `< 30d ⇒ "Nd ago"`, else a locale-formatted absolute date. The `nowMillis` parameter (rather than `System.currentTimeMillis()`) keeps the function testable.

### Interfaces

**`SessionMeta` (expanded)**

```kotlin
data class SessionMeta(
    val sessionId: String,
    val folderPath: String,
    val folderName: String,
    val name: String?,
    val archived: Boolean,
    val modified: String,        // ISO-8601 UTC, server-stamped where possible
    val created: String,         // ISO-8601 UTC
    val messageCount: Int,
    val firstMessage: String?,
    val cwd: String?,
)
```

**`reduceSessionEvent` (new signature)**

```kotlin
fun reduceSessionEvent(
    snapshot: SessionSnapshot,
    event: PimoteEvent,
    now: () -> String,
): ReducerResult
```

Behavioral contract changes from today:

- `SessionOpenedEvent` → inserts a `SessionMeta` with `name = null`, `archived = false`, `modified = created = now()`, `messageCount = 0`, `firstMessage = null`, `cwd = null`.
- `SessionReplacedEvent` → preserves the old row's `modified`, `created`, `messageCount`, `firstMessage`, `cwd` verbatim on the new `sessionId`.
- All other reductions unchanged.

**`SessionListGroups`**

```kotlin
data class SessionProjectGroup(
    val project: ProjectMeta,
    val sessions: List<SessionMeta>,
    val lastModified: String,
)

fun buildSessionProjectGroups(
    projects: List<ProjectMeta>,
    sessions: List<SessionMeta>,
): List<SessionProjectGroup>
```

Behavioral contract:

- Folders with no sessions are omitted.
- Within each group, sessions sort by `modified` desc, then `created` desc, then `sessionId` asc.
- Groups sort by `lastModified` desc, then `project.folderName` asc.
- `lastModified` equals the group's first session's `modified` after sorting.

**`SessionDisplay`**

```kotlin
fun sessionDisplayName(session: SessionMeta): String
fun shortenCwd(cwd: String): String
fun cwdLabelFor(session: SessionMeta, folderPath: String): String?
fun formatRelativeTime(isoTimestamp: String, nowMillis: Long): String
```

Behavioral contract:

- `sessionDisplayName`: `name` if non-blank → else `firstMessage` truncated to 60 chars + `…` if > 60 → else `"Session " + sessionId.take(8)`.
- `shortenCwd`: ≤ 2 non-empty segments returns input verbatim; otherwise `"…/seg-1/seg"` for the last two non-empty segments.
- `cwdLabelFor`: returns null when `session.cwd` is null/blank or equals `folderPath`; otherwise `shortenCwd(session.cwd)`.
- `formatRelativeTime`: thresholds `60s / 60m / 24h / 30d`; ISO parsing failures return a fallback date string (the input itself or `"—"`); negative diffs (clock skew) treated as "just now".

### DR Supersessions

_None._ DR-019 (contacts sync) is untouched; DR-016 (native Kotlin) and DR-013 (PWA-first / Android deferred) remain in force.

### Non-obvious decision: clock injection on the reducer

The wire's `session_opened` and `session_replaced` events do NOT carry `modified`/`created`/`messageCount`/`firstMessage`/`cwd`. The PWA refetches per-session metadata on `session_opened` (via `fetchFullSessionData`); Android currently has no equivalent path. Two options were considered:

1. **Clock-injected reducer (chosen).** `reduceSessionEvent` takes a `now: () -> String`. New rows seed `created = modified = now()` so they sort to the top of the list immediately. Stale `messageCount = 0` / `firstMessage = null` / `cwd = null` are corrected on the next manual refresh or WS reconnect bootstrap. Reducer remains pure given its inputs.
2. **Refetch effect.** Emit a `SessionEffect.RefetchFolder` on every `session_opened`. Adds a round-trip per session-open and complicates the test matrix (every `session_opened` test also asserts an effect). The user-visible payoff is small because the existing manual-refresh path already converges.

Option 1 is consistent with the rest of the reducer, simpler to test, and avoids per-open round-trips. Drawback: a freshly-opened session shows `0 msgs · just now` until the next refresh, which is acceptable UX given the prominent Refresh button on the screen and the WS-reconnect refresh.

## Tests

**Pre-test-write commit:** `0f29951a50b2cc836a0caa7cbe92514ccec9c5b6`

### Interface Files

- `mobile/android/app/src/main/kotlin/com/pimote/android/session/SessionRepository.kt` — expanded `SessionMeta` data class with the new fields (`modified`, `created`, `messageCount`, `firstMessage`, `cwd`), all defaulted so existing call sites continue to compile. `reduceSessionEvent` signature gains a `now: () -> String = { "" }` clock parameter, also defaulted.
- `mobile/android/app/src/main/kotlin/com/pimote/android/session/SessionListGroups.kt` — new file declaring `SessionProjectGroup` and the `buildSessionProjectGroups` pure function (body is `TODO()`).
- `mobile/android/app/src/main/kotlin/com/pimote/android/session/SessionDisplay.kt` — new file declaring `sessionDisplayName`, `shortenCwd`, `cwdLabelFor`, and `formatRelativeTime` pure functions (bodies are `TODO()`).

### Test Files

- `mobile/android/app/src/test/kotlin/com/pimote/android/session/SessionListGroupsTest.kt` — mirrors `client/src/lib/session-list-groups.test.ts` and adds Android-specific edge cases (tie-breakers, unparseable timestamps, orphan sessions).
- `mobile/android/app/src/test/kotlin/com/pimote/android/session/SessionDisplayTest.kt` — covers the display-name fallback chain, cwd shortening, the cwd-label suppression rule, and relative-time bucketing including negative-skew and unparseable-input edge cases.
- `mobile/android/app/src/test/kotlin/com/pimote/android/session/SessionReducerExpandedTest.kt` — pins the new clock-injected behavior on `session_opened` and the metadata-preservation behavior on `session_replaced`. Coexists with the existing `SessionReducerTest`.

### Behaviors Covered

#### buildSessionProjectGroups

- Folders with no sessions are dropped.
- Within a project, sessions sort by `modified` desc; ties break on `created` desc, then `sessionId` asc.
- Project groups sort by `lastModified` desc; ties break on `folderName` asc.
- `lastModified` equals the first session's `modified` after sorting.
- Unparseable timestamps sort to the bottom rather than crashing.
- Empty inputs return an empty list.
- Sessions whose `folderPath` matches no project are dropped.

#### sessionDisplayName

- Returns `name` when non-blank.
- Falls back to `firstMessage` when `name` is blank or null.
- Truncates `firstMessage` longer than 60 chars, appending `…`; passes through exactly-60-char strings verbatim.
- Falls back to `"Session <first 8 chars of sessionId>"` when both are absent; tolerates short session IDs.

#### shortenCwd

- Returns input unchanged for paths with ≤ 2 non-empty segments.
- For 3+ segments, returns `"…/" + lastTwoSegments.joinToString("/")`.
- Tolerates trailing slashes and consecutive slashes.
- Empty input returns empty.

#### cwdLabelFor

- Returns null when `cwd` is null, blank, or equals `folderPath`.
- Returns the shortened cwd when distinct.
- Returns the unchanged cwd when distinct AND short (≤ 2 segments).

#### formatRelativeTime

- `< 60 s` → `"just now"`; `< 60 m` → `"<n>m ago"`; `< 24 h` → `"<n>h ago"`; `< 30 d` → `"<n>d ago"`.
- Past 30 days falls through to a non-empty absolute date string.
- Negative diffs (clock skew) treated as `"just now"`.
- Unparseable input returns the input verbatim.

#### reduceSessionEvent (expanded)

- `session_opened` seeds `created` and `modified` from the injected `now` lambda.
- `session_opened` seeds `messageCount = 0`, `firstMessage = null`, `cwd = null`.
- `session_replaced` preserves the old row's `name`, `messageCount`, `firstMessage`, `cwd`, `modified`, and `created` on the new `sessionId`.

#### Out of unit-test scope

- The grouped Compose layout in `ContactsScreen.kt`: snapshot/UI tests are not part of this codebase's existing convention; manual on-device verification is the bar.
- `SessionRepositoryImpl.refresh` / `refetchFolder` populating the new fields from `SessionInfo`: integration with the WS layer; covered by `SessionRepositoryImplTest` adjustments during implementation rather than fresh test files.

**Review status:** approved

## Steps

**Pre-implementation commit:** `5346704f911b28644783b4f794c206f866fa33a1`

### Step 1: Implement display helpers (`SessionDisplay.kt`)

Replace all four `TODO()` bodies in `mobile/android/app/src/main/kotlin/com/pimote/android/session/SessionDisplay.kt`:

- `sessionDisplayName`: `name.takeIf { !it.isNullOrBlank() } ?: session.firstMessage?.let { if (it.length > 60) it.take(60) + "…" else it } ?: "Session ${session.sessionId.take(8)}"`.
- `shortenCwd`: split on `/`, drop empty segments. If ≤ 2 keep input verbatim (i.e. return `cwd` as-is). If ≥ 3, return `"…/" + segs.takeLast(2).joinToString("/")`.
- `cwdLabelFor`: return null if `session.cwd` is null/blank or equals `folderPath`; otherwise `shortenCwd(session.cwd)`.
- `formatRelativeTime`: parse via `java.time.Instant.parse`. On parse failure return the input verbatim. Compute `diffMs = nowMillis - parsed.toEpochMilli()`. Negative → `"just now"`. Bucket by 60 s / 60 m / 24 h / 30 d. Past 30 d return `java.time.format.DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withZone(ZoneId.systemDefault()).format(parsed)`.

**Verify:** `make android-test` — `SessionDisplayTest` passes (all 21 cases).
**Status:** done

### Step 2: Implement `buildSessionProjectGroups` (`SessionListGroups.kt`)

Replace the `TODO()` body. Algorithm:

1. Build `sessionsByPath: Map<String, List<SessionMeta>>` from the `sessions` argument grouped by `folderPath`.
2. For each project, look up its session list. Empty → drop.
3. Sort each project's sessions by `(modified desc, created desc, sessionId asc)` using `compareByDescending { parseTimestamp(it.modified) }.thenByDescending { parseTimestamp(it.created) }.thenBy { it.sessionId }`. Define a private `parseTimestamp(s: String): Long` that returns `Instant.parse(s).toEpochMilli()` or `0L` on failure (so unparseable timestamps sort to the bottom).
4. Construct `SessionProjectGroup(project, sortedSessions, lastModified = sortedSessions.first().modified)`.
5. Sort the resulting groups by `(parseTimestamp(lastModified) desc, project.folderName asc)`.

**Verify:** `make android-test` — `SessionListGroupsTest` passes (all 8 cases).
**Status:** done

### Step 3: Implement reducer expansion (`SessionRepository.kt`)

In `reduceSessionEvent`:

- Drop the default value on `now: () -> String`. Make it a required parameter to force every call site to pass a clock. (Existing `SessionReducerTest` will need a `fixedNow` helper; pass `{ "" }` or `{ "2026-01-01T00:00:00Z" }` — the existing tests don't assert on `modified`/`created` values.)
- `SessionOpenedEvent` branch: seed the new `SessionMeta` with `modified = now()`, `created = now()`, `messageCount = 0`, `firstMessage = null`, `cwd = null`.
- `SessionReplacedEvent` branch: when copying `old`, keep its `modified`, `created`, `messageCount`, `firstMessage`, `cwd` verbatim alongside the existing `name` preservation.
- All other branches unchanged.

Update `SessionReducerTest.kt` (existing file) so every `reduceSessionEvent(...)` call passes a `now` lambda. Do not weaken any existing assertion.

**Verify:** `make android-test` — both `SessionReducerTest` (existing 14 cases) and `SessionReducerExpandedTest` (3 new cases) pass.
**Status:** done

### Step 4: Wire the clock and rich fields through `SessionRepositoryImpl`

In `SessionRepository.kt`:

- Add a `nowProvider: () -> String = { java.time.Instant.now().toString() }` constructor parameter to `SessionRepositoryImpl`. Pass it into every `reduceSessionEvent(snap, ev, nowProvider)` call inside the `events.collect { … }` loop.
- In `refresh()` and `refetchFolder()`, populate `SessionMeta` from `SessionInfo` using its `modified`, `created`, `messageCount`, `firstMessage`, `cwd` fields.
- Update `AppContainer.kt` if it constructs `SessionRepositoryImpl` directly — it currently does. The default constructor argument means no change is required, but verify by reading the file.

**Verify:** `make android-test` — existing `SessionRepositoryImplTest` (4 cases) still passes. The wire-mock `SessionInfo` fixtures in that file already include `created`/`modified`/`messageCount`; no behavioral assertion change should be required.
**Status:** done

### Step 5: Rebuild `ContactsScreen` as a grouped LazyColumn

Edit `mobile/android/app/src/main/kotlin/com/pimote/android/ui/contacts/ContactsScreen.kt`:

- Replace the flat `rows` derivation with a call to `buildSessionProjectGroups(projects, sessions)`. Wrap in a `remember(projects, sessions)`.
- Replace the single `items(rows, key = { it.handleId }) { row -> ContactRow(…) }` with nested rendering: for each `SessionProjectGroup`, emit a project header row (using existing `ContactRow` with `kind = ContactKind.Project`, title = disambiguated folder label, subtitle = `"New session in this project"`), then `items(group.sessions, key = { it.sessionId })` rendering session rows (using existing `ContactRow` with `kind = ContactKind.Session`, title = `sessionDisplayName(s)`, subtitle composed from `cwdLabelFor`, message-count, and `formatRelativeTime(s.modified, System.currentTimeMillis())`).
- The subtitle composition rule: `listOfNotNull(cwdLabel, "$messageCount msg${if (messageCount != 1) "s" else ""}", relativeTime).joinToString(" · ")`. If `cwdLabel` is null the cwd dot is omitted, mirroring PWA layout.
- Keep the disambiguated folder labels via `PhoneAccountRules.disambiguateFolderLabels`. Project header uses the disambiguated label; session rows use `sessionDisplayName(session)` (NOT the prefixed `"folder/name"` format — the visual grouping makes the prefix redundant).
- Keep the existing `loadingHandleId`, `placeCall`, snackbar, refresh, status pill, and empty-state code paths unchanged. The handle-id mapping for taps is unchanged: project taps call `PhoneAccountRules.projectHandleId(folderPath)`, session taps call `PhoneAccountRules.sessionHandleId(sessionId)`.
- The relative-time string is computed at composition time from `System.currentTimeMillis()`. It will not auto-tick — acceptable for v1 (the PWA's relative time also doesn't tick without a refresh).

**Verify:** APK builds (`make android-build`). Visual verification deferred to Step 7.
**Status:** done

### Step 6: Full unit-suite verification

Run `make android-test` end-to-end. All 155 tests should pass: 124 existing + 31 newly-implemented (8 `SessionListGroupsTest` + 21 `SessionDisplayTest` + 2 net-new `SessionReducerExpandedTest` + 0 reducer-test regressions).

**Verify:** `make android-test` exits 0; output reports 155 tests, 0 failures.
**Status:** done

### Step 7: Manual on-device verification

Not a code step. Install the debug APK on a Pixel device with a configured Pimote origin and at least two projects with multiple sessions each.

1. Open Pimote. Confirm the contacts screen renders projects as headers, with their sessions listed underneath.
2. Confirm session rows show:
   - The display name (session name, or first-message excerpt, or `Session <id>` fallback).
   - The cwd hint (only when distinct from the project folder).
   - `<n> msg(s) · <relative time>`.
3. Confirm groups order by recency (most-recently-active project first).
4. Confirm sessions inside a group order by recency.
5. Tap a session row → outgoing call to that session via the existing Telecom path.
6. Tap a project row → outgoing "new session in project" call.
7. Pull-to-refresh / Refresh button still works; status pill / snackbar / empty states unchanged.
8. Open a brand-new session from the PWA → confirm it appears at the top of the right group within ~1 s, with `0 msgs · just now` until the next refresh corrects messageCount/firstMessage.

Discrepancies become follow-up steps; do not silently work around them.

**Verify:** All 8 manual checks pass. Discrepancies recorded as new steps in this plan.
**Status:** not started

## Follow-up: visual hierarchy fix

User feedback after on-device install of the initial implementation: "looks flat — needs per-project grouping, and message count + last time too." The list was structurally grouped but every row used the same `ContactRow` template (same height, same chevron, same press-flash background, only the icon differing) so the visual rhythm read as a flat list. The data-path concern in the same feedback was a misreport — message count and relative time were already landing correctly; only the visual treatment needed work.

### Step F1: Distinct project header treatment

Add a dedicated `ProjectHeaderRow` composable in a new file `mobile/android/app/src/main/kotlin/com/pimote/android/ui/contacts/ContactsRows.kt`:

- Section-title styling: `surfacePlus` background tint, `inkSecondary` text color, 40 dp min-height, `labelMedium` typography upper-cased with extra letter-spacing.
- Thin top divider drawn on every header except the first (caller passes `showTopDivider = groupIndex > 0`).
- The header itself is **not** tappable. The "call this project" affordance is a small inline `IconButton` on the right (`ic_call_outlined`, indigo tint, 36 dp). When the project's `handleId` is the active `loadingHandleId`, the IconButton swaps for a `CircularProgressIndicator`.

**Verify:** APK builds; project headers render visibly distinct from session rows.
**Status:** done

### Step F2: Indented session rows with PWA-style layout

In the same new file, add a dedicated `SessionListRow` composable:

- Indented from the screen edge by `spacing.ml + spacing.ml` (≈ 40 dp) so sessions visibly nest under the project header.
- Three-line layout in the title column:
  1. **Display name** — `bodyLarge` + `SemiBold`, `ink` color, single line, ellipsis on overflow.
  2. **Cwd hint** _(optional)_ — `bodySmall` italic, `inkSecondary`, only when `cwdLabelFor` returns non-null.
  3. **Metadata line** — `bodySmall`, `inkSecondary`, content `"<n> msg(s) · <relative time>"`. cwd is no longer joined into this line.
- Leading icon: `ic_chat_bubble_outlined`, `inkSecondary` tint, 18 dp; swapped for a 20 dp progress indicator while loading.
- Trailing chevron: `KeyboardArrowRight`, `inkDisabled` tint.
- Press-flash to `surfacePlus` for 100 ms, matching the original `ContactRow`.

`ContactsScreen` updates: `ContactsRow.SessionChild` now carries `cwdLabel: String?` and `metadataLine: String` separately (the previous single `subtitle` joined cwd with msgs/time, which made cwd hard to spot). `ContactsRow` rows also carry `groupIndex` so the renderer can suppress the divider on the first header. The `LazyColumn` `items` block dispatches to either `ProjectHeaderRow` or `SessionListRow` via `when (row)`. The shared `onCall` lambda (place-call + spinner-clear via `LaunchedEffect(callState)`) is reused by both.

**Verify:** APK builds; 155 unit tests still pass (visual change has no test-suite impact; pure helpers unchanged).
**Status:** done

### Step F3: Manual on-device verification (extended)

Re-install the debug APK on a Pixel device with ≥ 2 projects and multiple sessions per project. Verify:

1. **Project headers** are visibly distinct from session rows: shorter height, tinted background (`surfacePlus`), uppercase label, no chevron, with a small indigo phone-icon button on the right.
2. **Sessions are indented** under their project header — there's a clear left-edge step inward from header to session rows.
3. **Each session row shows three lines** when applicable:
   - The display name in a clearly bolder/larger weight than the metadata.
   - An italic muted cwd line only when the session's `cwd` differs from its project folder.
   - A `"<n> msgs · <relative time>"` line.
4. **Top divider** is drawn between groups but not above the first group.
5. **Tap targets:**
   - Tapping a project header itself does nothing.
   - Tapping the project header's **phone icon button** places the project's hotline call.
   - Tapping a session row places that session's call.
6. Loading spinner appears on the row whose call is in flight (project icon button or session row), and clears once the controller leaves Idle.
7. Pull-to-refresh / Refresh button / WS status pill / snackbar / empty states unchanged.
8. Layout still feels right with one-project-one-session and many-projects-many-sessions edge cases.

**Verify:** All 8 checks pass. Discrepancies recorded as new follow-up steps.
**Status:** not started
