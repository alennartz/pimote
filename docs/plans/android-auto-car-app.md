# Plan: Android Auto Car App — Project/Session Call Picker

## Context

Add a minimal Android Auto surface to the native Android client: a head-unit launcher tile that
opens a project list (tap a project = place a new-session hotline call) plus a header action that
opens a recency-sorted resume list (tap a session = resume it). The car screens are a **picker
only** — they construct a `pimote:` dial URI and hand it to the existing
`CallByPimoteUri.placeCall` → `PimoteConnectionService` → `CallController` machinery, which already
works in the car. See `docs/brainstorms/android-auto-car-app.md`.

Two DRs frame this work:

- **DR-013** deferred Android Auto to v2 and assumed it would arrive "natively" via the
  ConnectionService/Telecom path; it never contemplated a `CarAppService`. We're now in that v2
  territory, adding a surface DR-013 didn't foresee. Not contradicted.
- **DR-025** routes voice resolution through App Actions and claims _"Voice works in practice.
  Verified on Pixel 8 / Android 16."_ The user's lived experience is that Assistant-initiated
  calling has never worked. This plan does **not** supersede DR-025 — the work is purely additive,
  leaving the App Actions / contacts-sync surfaces untouched and adding a tap-based car surface
  alongside DR-025's three. The tension is recorded here for visibility, not resolved.

## Architecture

### Impacted Modules

**Android Client** (`mobile/android/`):

- **App module build + manifest** — add `androidx.car.app:app` and `androidx.car.app:app-projected`
  dependencies; declare the new `CarAppService` with the POI category and required car-app
  meta-data; add an `automotive_app_desc` resource. No changes to existing permissions or services.
- **`AppContainer` / `Context.pimoteContainer`** — unchanged in shape; the new `CarAppService` is
  one more framework-instantiated entry point that reads the process-wide container (specifically
  `SessionRepository`, `TelecomFacade`) the same way Activities/Services do today. No new
  container fields required (the car screens reuse `SessionRepository`, `CallByPimoteUri`,
  `PhoneAccountRules`).
- **`telephony` / `shortcuts`** — unchanged. The car screens reuse `PhoneAccountRules.projectHandleId`
  / `sessionHandleId` for URI encoding and `CallByPimoteUri.placeCall` for dispatch. The existing
  `PimoteConnectionService` → `PhoneAccountRules.parseDialUri` → `CallController` path already
  branches correctly between project (new session) and session (resume) dial URIs; no call logic is
  added.

### New Modules

**`car/`** (new package `com.pimote.android.car`, under the Android Client) — the Android Auto
templated surface.

- **Purpose:** host a `CarAppService` that renders the project-call and resume-session picker on the
  head unit and dispatches taps into the existing call machinery.
- **Responsibilities:**
  - `PimoteCarAppService` (extends `androidx.car.app.CarAppService`) — host integration:
    `createHostValidator()` (allow the Android Auto host; permissive validator acceptable for a
    sideloaded personal build) and `onCreateSession()` returning `PimoteCarSession`.
  - `PimoteCarSession` (extends `androidx.car.app.Session`) — returns `ProjectListScreen` as the
    root screen on `onCreateScreen()`. Reads the container via `carContext` (a `Context`).
  - `ProjectListScreen` (extends `Screen`) — thin shell. Reads `SessionRepository.projects` /
    `.sessions` `.value`, computes rows via `CarRowModels.projectCallRows(...)`, renders a
    `ListTemplate` with a header `ActionStrip` "Sessions" button (pushes `ResumeSessionsScreen`).
    Row tap → `CallByPimoteUri.placeCall(carContext, row.dialUri, container.telecomFacade)` then a
    transient `CarToast`. Subscribes to the two `StateFlow`s on the screen lifecycle and calls
    `invalidate()` on change.
  - `ResumeSessionsScreen` (extends `Screen`) — thin shell. Reads `SessionRepository.sessions`,
    computes rows via `CarRowModels.resumeSessionRows(...)`, renders a flat recency-sorted
    `ListTemplate`. Row tap → `placeCall` + `CarToast`. Same invalidate-on-flow lifecycle wiring.
  - `CarRowModels.kt` — **pure helpers**, the entire testable surface of the module. Transform
    `(projects, sessions, now, limit)` into ordered, truncated row view-models. Also a small pure
    `carListMessage(...)` helper for the degraded-state text. No Android framework types beyond the
    existing pure DTOs (`ProjectMeta`, `SessionMeta`) and the existing pure helpers it composes
    (`SessionDisplay`, `PhoneAccountRules`).
- **Dependencies:** `androidx.car.app` (templates), `session` (`SessionRepository`, `ProjectMeta`,
  `SessionMeta`, `SessionDisplay`, `SessionListGroups` if useful), `shortcuts`
  (`CallByPimoteUri`), `telephony` (`PhoneAccountRules`, `TelecomFacade`), `app`
  (`Context.pimoteContainer`).
- **Location:** `mobile/android/app/src/main/kotlin/com/pimote/android/car/`; tests under
  `mobile/android/app/src/test/kotlin/com/pimote/android/car/`.

### Interfaces

#### `CarRowModels` — pure row derivation (the unit-tested seam)

```kotlin
/** One rendered list row for a car ListTemplate. */
data class CarRow(
    /** Stable key: the source-id handle ("project:<b64>" or "session:<id>"). */
    val key: String,
    val title: String,
    val subtitle: String,
    /** Full dial URI to hand to CallByPimoteUri.placeCall, e.g. "pimote:project:<b64>". */
    val dialUri: String,
)

object CarRowModels {
    /**
     * Project-call rows for Screen 1. One row per project. Tapping places the
     * project hotline (new session) call.
     *
     * Ordering: by most-recent session activity (max `modified` over the
     * project's sessions) descending; projects with no sessions sort last,
     * ordered by title.
     * Title: project label (basename; `<root> <basename>` style optional via
     *   existing helpers — implementer's choice, must be stable & non-empty).
     * Subtitle: session count + relative last-activity, e.g. "3 sessions · 5m ago";
     *   "No sessions yet" when the project has none.
     * dialUri: "pimote:" + PhoneAccountRules.projectHandleId(folderPath).
     * Truncation: at most `limit` rows after sorting (limit comes from the host
     *   ConstraintManager at the call site).
     */
    fun projectCallRows(
        projects: List<ProjectMeta>,
        sessions: List<SessionMeta>,
        nowMillis: Long,
        limit: Int,
    ): List<CarRow>

    /**
     * Resume rows for Screen 2. Flat, NOT grouped by project.
     *
     * Ordering: by `modified` descending (most recent first).
     * Title: SessionDisplay.sessionDisplayName(session).
     * Subtitle: relative time (SessionDisplay.formatRelativeTime), optionally a
     *   cwd hint; must be non-empty.
     * dialUri: "pimote:" + PhoneAccountRules.sessionHandleId(sessionId).
     * Truncation: at most `limit` rows after sorting.
     * Archived sessions are already excluded upstream (SessionRepository.sessions
     *   is unarchived-only); no extra filtering required.
     */
    fun resumeSessionRows(
        sessions: List<SessionMeta>,
        nowMillis: Long,
        limit: Int,
    ): List<CarRow>

    /**
     * Degraded-state message for an otherwise-empty list, or null when there is
     * content to show. Pure mapping over configuration/connection/availability
     * inputs. Precedence: origin first (it gates everything), then connection,
     * then emptiness.
     *  - origin not configured → a message that names the real problem AND that
     *    it can't be fixed from the head unit (must be set on the phone), e.g.
     *    "Set the Pimote server address on your phone". NOT "Connecting…".
     *  - origin set but not connected → "Connecting to Pimote…" / "Pimote offline"
     *  - connected, no projects → "No projects yet"
     * The screen renders a MessageTemplate with this string instead of the list
     * when rows are empty.
     */
    fun carListMessage(
        originConfigured: Boolean,
        connected: Boolean,
        hasProjects: Boolean,
    ): String?
}
```

**Behavioral contracts the test writer must pin:**

- `projectCallRows`: emits one row per project; recency ordering with no-session projects last;
  correct `dialUri` (`pimote:project:<b64>`); subtitle pluralization and "No sessions yet" branch;
  truncation honors `limit` (e.g. `limit = 2` over 5 projects → first 2 by recency).
- `resumeSessionRows`: flat recency order across all projects (a session in project B newer than
  one in project A sorts first); correct `dialUri` (`pimote:session:<id>`); truncation honors
  `limit`; empty input → empty list.
- `carListMessage`: when `originConfigured = false`, returns the configure-on-phone message
  regardless of `connected`/`hasProjects` (and it must read as a phone-side fix, not a transient
  connection state); else returns the disconnected message when `connected = false` regardless of
  projects; "No projects yet" when configured, connected, and `hasProjects = false`; `null` when
  there is content.

#### Screen ↔ host contract (framework glue, not unit-tested)

- `onGetTemplate()` reads the current `StateFlow.value`s, obtains the list limit via
  `carContext.getCarService(ConstraintManager::class.java).getContentLimit(CONTENT_LIMIT_TYPE_LIST)`,
  builds rows via `CarRowModels`, and returns a `ListTemplate` (or `MessageTemplate` when
  `carListMessage(...) != null`).
- Reactivity: each screen launches a collector on its own lifecycle scope over the relevant
  `StateFlow`(s); on emission it calls `invalidate()`, which re-drives `onGetTemplate()`. The
  closure captures the screen instance (final), not a reassignable slot.
- Row tap handlers call `CallByPimoteUri.placeCall(carContext, row.dialUri, container.telecomFacade)`
  and show a `CarToast`. No new call orchestration; dispatch outcome is owned by `CallController`.

#### Dial-URI reuse (existing, unchanged)

- Project: `"pimote:" + PhoneAccountRules.projectHandleId(folderPath)` →
  `PhoneAccountRules.parseDialUri` → `SessionTarget.NewSessionInProject` → `open_session` (new) →
  bind.
- Session: `"pimote:" + PhoneAccountRules.sessionHandleId(sessionId)` → `parseDialUri` →
  `SessionTarget.ExistingSession` → bind directly (resume).

### Technology Choices

**Android for Cars App Library — `androidx.car.app:app:1.7.0` + `androidx.car.app:app-projected:1.7.0`.**

- **Chosen:** the only first-party framework for third-party **non-navigation** templated UI on
  Android Auto. `app` provides the templates/models; `app-projected` provides the Android Auto
  (phone-projection) host runtime. Version 1.7.0 is the latest **stable** (1.8.x/1.9.x are
  alpha/beta — excluded per the latest-stable rule). minSdk 26 / compileSdk 36 are compatible.
- **Alternatives considered (and rejected in the brainstorm):**
  - _Media-browse hack_ (`MediaBrowserService`, like Spotify/Podcast Addict) to inherit unbounded
    sectioned lists — rejected: "playing" an item would have to secretly place a call, the
    now-playing UI expects media transport, and a `MediaSession` would fight the self-managed
    Telecom call for audio focus. Semantically wrong and fragile.
  - _Android Automotive OS native app_ — different platform (the car's built-in OS), not something
    sideloaded onto a phone; out of scope.

### Manifest / Resource Changes

- `<service android:name=".car.PimoteCarAppService" android:exported="true">` with an
  `<intent-filter>` for action `androidx.car.app.CarAppService` and category
  `androidx.car.app.category.POI`.
- `<meta-data android:name="androidx.car.app.minCarApiLevel" android:value="1" />` on the service
  (or the level matching 1.7.0's templates actually used).
- Application-level `<meta-data android:name="com.google.android.gms.car.application"
android:resource="@xml/automotive_app_desc" />` and a new `res/xml/automotive_app_desc.xml`
  declaring `<uses name="template" />`.
- No new permissions. Distribution is sideload + Android Auto "Unknown sources" dev mode.

### Deferred / Minimal-Scope Notes (from brainstorm open questions)

- **Post-tap feedback:** a transient `CarToast` ("Calling…"); Android Auto's own in-call UI then
  takes over. No custom in-call car screen (DR-025 / `android-auto-ui-exploration.md` already
  established third-party calling apps can't draw custom in-call UI).
- **Active-call entry:** if opened while a call is bound, v1 just shows the list; tapping routes
  through `CallController`'s existing displacement handling. No special-casing in v1.
- **Degraded states:** handled via `carListMessage(originConfigured, connected, hasProjects)` →
  `MessageTemplate`. Origin-not-configured is distinct from disconnected: the head unit can't set
  the origin, so the message must direct the user to their phone. The screen reads
  `originConfigured` from the container's `Settings` config (non-blank `pimoteOrigin`) and
  `connected` from `WsClient` state.
