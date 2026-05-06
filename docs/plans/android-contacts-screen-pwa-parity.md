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
