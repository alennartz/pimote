# Plan: Android — Assistant-callable Pimote projects

## Context

Make Pimote projects voice-callable via Google Assistant ("Hey Google, call &lt;project&gt;") and tappable from the system contact card. DR-024's design wired only ContactsContract custom-MIME, which empirically gives neither voice resolution nor a contact-card action button. See `docs/brainstorms/android-assistant-callable-projects.md` for the rationale.

## Architecture

### Impacted Modules

- **Android Client / `contacts/`** — `ContactsSync.computeDesiredContacts` changes the contact display name format to `"<root> <project>"` (e.g. `repos pimote`), removing the call to `PhoneAccountRules.disambiguateFolderLabels` for that purpose. The custom-MIME row, sync runner, SyncAdapter shim, and Settings row are unchanged. Falls back to bare project name when the root segment can't be derived.

- **Android Client / `telephony/PhoneAccountRules.kt`** — gains a pure helper `rootSegmentOf(folderPath: String): String?` returning the parent path's last segment. `disambiguateFolderLabels` is retained for the in-app `ContactsScreen` (which still uses it for short labels) but no longer called from `ContactsSync`.

- **Android Client / `app/AppContainer.kt`** — instantiates and starts the new `ShortcutsRunner` alongside the existing `ContactSyncRunner`, wired off the same `SessionRepository`.

- **Android Client manifest (`AndroidManifest.xml`)** — adds the App Actions shortcuts meta-data on `MainActivity`; declares the two new trampoline activities (one with an `<intent-filter>` for the contact-card path, one with no intent filter for the App Actions fulfillment path).

### New Modules

#### `shortcuts/`

Owns the App Actions / dynamic-shortcut surface. Lives at `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/`. Mirrors the shape of `contacts/` (pure-function diff + a runner + a facade).

**Responsibilities:**

- Pure-function derivation of the desired dynamic-shortcut set from project list + per-project last-activity timestamps + system shortcut cap.
- Reconciling the desired set with the current dynamic shortcuts via `ShortcutManagerCompat.setDynamicShortcuts(...)`, debounced, on changes from `SessionRepository`.
- Two trampoline activities that turn an Assistant fulfillment intent or a contact-card `ACTION_VIEW` intent into a `Telecom.placeCall(pimote:..., extras_with_PimotePhoneAccountHandle)`.

**Dependencies:** `session/SessionRepository`, `session/SessionListGroups`, `telephony/PhoneAccountRules`, `telephony/TelecomFacade`. No new third-party deps; uses `androidx.core:core` (already on the path) for `ShortcutManagerCompat` / `ShortcutInfoCompat`.

**Approximate files:**

- `shortcuts/ShortcutsSync.kt` — pure `computeDesiredShortcuts(...)` + `diff(...)` + `synonymsFor(...)` + fuzzy-match resolver.
- `shortcuts/ShortcutsRunner.kt` — observes `SessionRepository.{projects, sessions}`, debounces, applies `setDynamicShortcuts(...)`.
- `shortcuts/ShortcutManagerFacade.kt` (interface) + `shortcuts/AndroidShortcutManagerFacade.kt` — test seam over `ShortcutManagerCompat`.
- `shortcuts/CallByPimoteUri.kt` — shared helper `placeCall(context, pimoteUri)` used by both trampoline activities.
- `shortcuts/CallByNameActivity.kt` — App Actions fulfillment trampoline.
- `shortcuts/CallByDataRowActivity.kt` — contact-card `ACTION_VIEW` trampoline.
- `shortcuts/res/xml/shortcuts.xml` (lives at `mobile/android/app/src/main/res/xml/shortcuts.xml` per Android conventions, but logically owned by this module) — declares `actions.intent.CREATE_CALL` capability.

### Interfaces

#### `PhoneAccountRules.rootSegmentOf`

```kotlin
/**
 * Returns the last path segment of [folderPath]'s parent — the configured
 * server-side "root" segment that groups projects (e.g. "repos", "work").
 * Returns null if the parent has no segment (root-of-filesystem edge case)
 * or the input is malformed. Pure; uses '/' as the only separator.
 */
fun PhoneAccountRules.rootSegmentOf(folderPath: String): String?
```

Examples:

- `/Users/alenna/repos/pimote` → `"repos"`
- `/repos/pimote` → `"repos"`
- `/pimote` → `null` (parent is root)
- `pimote` → `null` (no parent)
- `""` → `null`

#### `ShortcutsSync` (pure)

```kotlin
data class DesiredShortcut(
    val shortcutId: String,                  // "project:<base64>" or "fallback"
    val shortLabel: String,                  // e.g. "repos pimote"
    val longLabel: String,                   // e.g. "Call repos pimote"
    val capabilityParameter: String,         // value bound to call.participant.name; "fallback" for the generic shortcut
    val synonyms: List<String>,              // utterance variants for the parameter binding
    val pimoteUri: String?,                  // pimote:project:<base64> for project shortcuts; null for the fallback (resolved at fulfillment time)
    val rank: Int,                           // 0 = highest. Drives ShortcutInfoCompat.setRank().
)

object ShortcutsSync {
    /**
     * Build the desired shortcut list from sorted project groups (most-recent first)
     * and the runtime cap. Returns at most [maxShortcuts] entries:
     *   - rank 0: the generic fallback shortcut (always present)
     *   - rank 1..N-1: top (maxShortcuts - 1) projects by recency
     * Long-tail projects (beyond the cap) are NOT in the result; they remain
     * callable via the contact-card surface but not voice.
     */
    fun computeDesiredShortcuts(
        groups: List<SessionProjectGroup>,
        maxShortcuts: Int,
    ): List<DesiredShortcut>

    /** Diff two lists by shortcutId + content equality. Apply: deletes, then upserts. */
    fun diff(
        desired: List<DesiredShortcut>,
        existing: List<DesiredShortcut>,
    ): SyncOps

    /**
     * Synonym set for a project shortcut. Examples:
     *   synonymsFor("repos", "pimote") → ["pimote", "repos pimote", "repos / pimote", "pimote repos"]
     *   synonymsFor(null, "pimote")    → ["pimote"]
     * No pronunciation variants here — those only go on the fallback shortcut.
     */
    fun synonymsFor(rootSegment: String?, projectName: String): List<String>

    /**
     * Best-effort match of an Assistant-recognized utterance against the full
     * project list. Returns the matched project's pimoteUri or null if no
     * candidate scores above an internal threshold. Used by CallByNameActivity
     * as a defensive fallback when the recognized parameter doesn't equal any
     * known shortcut's capabilityParameter.
     */
    fun resolveByFuzzyMatch(
        utterance: String,
        projects: List<ProjectMeta>,
    ): String?

    data class SyncOps(
        val toDelete: List<String>,          // shortcutIds
        val toUpsert: List<DesiredShortcut>, // full state for setDynamicShortcuts
    )

    /** Fixed sentinel id for the generic fallback shortcut. */
    const val FALLBACK_SHORTCUT_ID: String = "fallback"

    /** Fixed sentinel parameter value for the generic fallback shortcut. */
    const val FALLBACK_PARAMETER: String = "fallback"

    /** Synonyms for the generic fallback shortcut, including pronunciation variants. */
    val FALLBACK_SYNONYMS: List<String> // ["Pimote", "pee mote", "pee-mote", "pie mote", "pie-mote", "my pi"]
}
```

#### `ShortcutManagerFacade`

```kotlin
interface ShortcutManagerFacade {
    /** Runtime cap. Returns 15 (or another safe constant) if the system value is unavailable. */
    fun getMaxShortcutCountPerActivity(): Int

    /** Replace the full set of dynamic shortcuts. Idempotent on equal inputs. */
    fun setDynamicShortcuts(shortcuts: List<DesiredShortcut>)

    /** Read current dynamic shortcuts (for diff). */
    fun getDynamicShortcuts(): List<DesiredShortcut>
}
```

`AndroidShortcutManagerFacade` is the production binding — translates `DesiredShortcut` to `ShortcutInfoCompat` (with `addCapabilityBinding(...)`, `setRank(...)`, `setLongLived(true)`, `setIntent(...)` pointing at `CallByNameActivity` with `participantName` extra equal to `capabilityParameter`).

#### `ShortcutsRunner`

```kotlin
class ShortcutsRunner(
    private val context: Context,
    private val repository: SessionRepository,
    private val shortcutManager: ShortcutManagerFacade,
    private val scope: CoroutineScope,
    private val debounceMs: Long = 2_000L,
) {
    fun start()  // launches the combine+debounce+reconcile coroutine
    fun stop()
}
```

Reconcile loop:

1. Compute `groups = buildSessionProjectGroups(projects, sessions)`.
2. `cap = max(shortcutManager.getMaxShortcutCountPerActivity(), 2)`.
3. `desired = ShortcutsSync.computeDesiredShortcuts(groups, cap)`.
4. `existing = shortcutManager.getDynamicShortcuts()`.
5. If desired ≠ existing: `shortcutManager.setDynamicShortcuts(desired)`.

The 2 s debounce mirrors `ContactSyncRunner` deliberately — both runners observe the same `SessionRepository` flow, and the brainstorm's "re-rank on every project list change" is satisfied by debounced reconciliation rather than per-event push (the same trade-off `ContactSync` already makes).

Failures inside the loop are caught and logged via `L.w(...)` so a transient `ShortcutManager` exception doesn't kill the flow. Same posture as `ContactSyncRunner`.

#### `CallByPimoteUri`

```kotlin
object CallByPimoteUri {
    /**
     * Place an outgoing call to [pimoteUri] via Telecom, scoped to the Pimote
     * self-managed PhoneAccount (so dispatch stays inside our ConnectionService
     * and doesn't compete with the SIM). Returns true if dispatched, false if
     * the URI was rejected or the PhoneAccount is missing.
     */
    fun placeCall(context: Context, pimoteUri: String, telecom: TelecomFacade): Boolean
}
```

#### `CallByNameActivity`

Headless (`Theme.NoDisplay`). Reads `intent.getStringExtra("participantName")`. The unified-trampoline alternative (one activity handling both Assistant fulfillment and the contact-card `ACTION_VIEW`) was considered and rejected — the two intent contracts are completely different (string extras vs `ContactsContract.Data` row URI), so a single activity would have to runtime-branch on intent shape. Two ~30-line trampolines delegating to a shared helper is clearer and easier to test.

Resolution order:

1. If value equals `ShortcutsSync.FALLBACK_PARAMETER`: resolve to most-recently-active project via `SessionRepository.{projects,sessions}` snapshot + `buildSessionProjectGroups`. If none, show toast `"No projects available"` and finish.
2. Else: search known shortcut capability parameters for an exact match.
3. Else: `ShortcutsSync.resolveByFuzzyMatch(utterance, projects)` over the full project list.
4. Else: launch `MainActivity` (defensive) and finish.

On match, call `CallByPimoteUri.placeCall(...)`. Always `finish()` immediately.

#### `CallByDataRowActivity`

Headless (`Theme.NoDisplay`). Reads `intent.data` (the Data row URI). Queries `ContactsContract.Data` for `data1` where the row id matches. If non-empty and parseable as a `pimote:` URI: `CallByPimoteUri.placeCall(...)`. Always `finish()`.

#### `shortcuts.xml`

```xml
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <capability android:name="actions.intent.CREATE_CALL">
        <intent
            android:action="android.intent.action.VIEW"
            android:targetPackage="com.pimote.android"
            android:targetClass="com.pimote.android.shortcuts.CallByNameActivity">
            <parameter
                android:name="call.participant.name"
                android:key="participantName"/>
        </intent>
    </capability>
</shortcuts>
```

Dynamic shortcuts (built by `AndroidShortcutManagerFacade`) bind to this capability via `addCapabilityBinding("actions.intent.CREATE_CALL", "call.participant.name", synonyms)`.

#### Manifest deltas

```xml
<!-- on MainActivity -->
<meta-data
    android:name="android.app.shortcuts"
    android:resource="@xml/shortcuts" />

<activity
    android:name=".shortcuts.CallByNameActivity"
    android:exported="true"
    android:theme="@android:style/Theme.NoDisplay" />

<activity
    android:name=".shortcuts.CallByDataRowActivity"
    android:exported="true"
    android:theme="@android:style/Theme.NoDisplay">
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="vnd.android.cursor.item/vnd.com.pimote.android.call" />
    </intent-filter>
</activity>
```

### DR Supersessions

- **DR-024** (Pimote contacts as Assistant-discoverable callable-MIME rows) — partially superseded. The structural choices it kept from DR-019 (single self-managed PhoneAccount, `pimote:` URI scheme, AccountManager-owned contact rows, projects-only sync, SyncAdapter shim, runtime contacts permissions, `Settings.UNGROUPED_VISIBLE` row) all carry forward unchanged. What's superseded is its central claim that the custom-MIME `<ContactsDataKind>` + `CONTACTS_STRUCTURE` resource alone makes Pimote contacts Assistant-callable and renders a contact-card action. AOSP `DataKind.java` builds the per-MIME card action by resolving `Intent(ACTION_VIEW).setDataAndType(rowUri, mimeType)` against installed activities — without an activity declaring an `<intent-filter>` for that action+MIME, no button renders. Google Assistant's "call X" voice resolver searches `ContactsContract` only for `tel:` `Phone` rows; non-`tel:` calling apps integrate via App Actions (`actions.intent.CREATE_CALL` capability + dynamic shortcuts) instead. The new decision: keep DR-024's ContactsContract structure for visibility/dialer-search, add a `CallByDataRowActivity` with an `ACTION_VIEW` intent filter for the contact-card button, and add the `shortcuts/` module + App Actions integration for voice. The 15-shortcut system cap on Assistant-visible voice targets is accepted; long-tail projects remain callable via the contact-card and dialer surfaces.

## Tests

**Pre-test-write commit:** `eeee35006d4a4155d14a1f96b4ca6013bd237130`

### Interface Files

- `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/PhoneAccountRegistrar.kt` — adds the `PhoneAccountRules.rootSegmentOf(folderPath): String?` helper (stubbed).
- `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/ShortcutsSync.kt` — `DesiredShortcut` data class, `ShortcutsSync` object exposing `computeDesiredShortcuts`, `diff`, `synonymsFor`, `resolveByFuzzyMatch`, plus `FALLBACK_SHORTCUT_ID` / `FALLBACK_PARAMETER` / `FALLBACK_SYNONYMS` constants and the `SyncOps` data class. All methods stubbed.
- `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/ShortcutManagerFacade.kt` — test seam over `ShortcutManagerCompat`.
- `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/AndroidShortcutManagerFacade.kt` — production binding (stubbed).
- `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/ShortcutsRunner.kt` — runner class with `start()` / `stop()` stubs.
- `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/CallByPimoteUri.kt` — shared `placeCall` helper (stub).
- `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/CallByNameActivity.kt` — App Actions fulfillment trampoline (skeleton; `finish()` only).
- `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/CallByDataRowActivity.kt` — contact-card `ACTION_VIEW` trampoline (skeleton; `finish()` only).
- `mobile/android/app/src/main/res/xml/shortcuts.xml` — declares the `actions.intent.CREATE_CALL` capability.
- `mobile/android/app/src/main/AndroidManifest.xml` — adds the `android.app.shortcuts` meta-data on `MainActivity` and declares the two trampoline activities (`CallByNameActivity`, `CallByDataRowActivity` with the callable-MIME `ACTION_VIEW` filter).
- `mobile/android/app/src/main/kotlin/com/pimote/android/app/AppContainer.kt` — instantiates `AndroidShortcutManagerFacade` and `ShortcutsRunner` alongside the existing `ContactSyncRunner`.

### Test Files

- `mobile/android/app/src/test/kotlin/com/pimote/android/telephony/PhoneAccountRulesTest.kt` — extended with five `rootSegmentOf` cases.
- `mobile/android/app/src/test/kotlin/com/pimote/android/contacts/ContactsSyncTest.kt` — updated `computeDesiredContacts` cases for the new `"<root> <project>"` display-name format (replaces the old `disambiguateFolderLabels`-based collision case; adds a fallback case for top-level paths where the parent has no segment).
- `mobile/android/app/src/test/kotlin/com/pimote/android/shortcuts/ShortcutsSyncTest.kt` — new pure-function tests covering `computeDesiredShortcuts`, `synonymsFor`, `resolveByFuzzyMatch`, and `diff`.

### Behaviors Covered

#### `PhoneAccountRules.rootSegmentOf`

- Returns the parent path's last segment for a deep absolute path (`/Users/alenna/repos/pimote` → `"repos"`).
- Returns the parent's only segment when there is just one above the basename (`/repos/pimote` → `"repos"`).
- Returns null when the parent has no segment (`/pimote`).
- Returns null when the input has no parent at all (`pimote`).
- Returns null on empty input.

#### `ContactsSync.computeDesiredContacts` (revised display-name format)

- Project contact display name is `"<root> <project>"` when the parent path has a segment (`/work/repo` → `"work repo"`).
- Falls back to the bare project name when `rootSegmentOf` is null (`/repo` → `"repo"`).
- Folder-name collisions across distinct roots are naturally distinguished by the root prefix (`/work/repo` and `/personal/repo` produce `"work repo"` / `"personal repo"`).

#### `ShortcutsSync.computeDesiredShortcuts`

- The result always contains the fallback shortcut at rank 0, even when there are no projects.
- The fallback shortcut has `shortcutId == FALLBACK_SHORTCUT_ID`, `capabilityParameter == FALLBACK_PARAMETER`, and a null `pimoteUri` (resolved at fulfillment time).
- The result is capped at `maxShortcuts` entries.
- Project entries are picked from the head of the (already-sorted) input ordering.
- `maxShortcuts == 1` yields only the fallback (no projects).
- Project `shortLabel` uses the `"<root> <project>"` form (`/repos/pimote` → `"repos pimote"`).
- Project `longLabel` is the call-prefixed variant (begins with `"Call "`).
- Project shortcuts carry a `pimote:project:<base64>` URI matching `PhoneAccountRules.projectHandleId`.
- Project ranks are non-zero and ascend by recency starting at 1 (0=fallback, 1, 2, ...).
- The fallback shortcut carries the canonical `FALLBACK_SYNONYMS` list (including pronunciation variants).

#### `ShortcutsSync.synonymsFor`

- Includes the bare project name as a synonym.
- Includes a `"<root> <project>"` combination synonym when a root is supplied.
- Returns just the bare project name when the root is null.
- Never includes pronunciation variants of "Pimote" itself — those belong only on the fallback shortcut.

#### `ShortcutsSync.resolveByFuzzyMatch`

- Returns null on an empty project list.
- Returns the matching project's `pimote:` URI for an utterance that matches a project's name exactly.
- Returns null for utterances that don't match anything recognisable.

#### `ShortcutsSync.diff`

- Emits an upsert for shortcut ids only present in `desired`.
- Emits a delete for shortcut ids only present in `existing`.
- Emits an upsert when an id is present in both but the content differs.
- Emits no operations when `desired` and `existing` are content-equal.
