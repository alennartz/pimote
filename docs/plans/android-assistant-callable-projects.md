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
- Treats `rank`, `synonyms`, `pimoteUri`, and `capabilityParameter` as content — mutating any of them triggers an upsert.
- Emits no operations when `desired` and `existing` are content-equal.

**Review status:** approved

## Steps

### Step 1: Implement `PhoneAccountRules.rootSegmentOf`

Replace the `TODO` body in `mobile/android/app/src/main/kotlin/com/pimote/android/telephony/PhoneAccountRegistrar.kt` so the helper returns the last `/`-delimited segment of `folderPath`'s parent. Edge handling already specified by the doc-comment and the five `PhoneAccountRulesTest.rootSegmentOf*` cases:

- `/Users/alenna/repos/pimote` → `"repos"`
- `/repos/pimote` → `"repos"`
- `/pimote` → `null`
- `pimote` → `null`
- `""` → `null`

Pure Kotlin string handling — no path APIs needed. Drop empty segments before picking the second-to-last.

**Verify:** `make android-test` runs `PhoneAccountRulesTest` cleanly and all five `rootSegmentOf` cases pass.
**Status:** not started

### Step 2: Switch `ContactsSync.computeDesiredContacts` to the `"<root> <project>"` display-name format

In `mobile/android/app/src/main/kotlin/com/pimote/android/contacts/ContactsSync.kt`, change `computeDesiredContacts` so the per-project `displayName` is built from `PhoneAccountRules.rootSegmentOf(p.folderPath)` plus the project basename rather than `disambiguateFolderLabels`. Keep `sanitize` on the final composed string so empty/whitespace inputs still drop. Behavior expected by `ContactsSyncTest`:

- `/work/repo` → `"work repo"`
- `/repo` (no parent segment) → `"repo"` (bare basename fallback)
- `/work/repo` and `/personal/repo` coexist as `"work repo"` / `"personal repo"`
- whitespace-only basename still drops the contact silently

The `sourceId`, `pimoteUri`, and `summary` fields are unchanged — only `displayName` derivation moves. The `disambiguateFolderLabels` call is removed from this function (the helper itself stays for `ContactsScreen`).

**Verify:** `ContactsSyncTest` passes including the new `falls back to bare folderName` and `colliding folder names are disambiguated by root segment prefix` cases.
**Status:** not started

### Step 3: Implement `ShortcutsSync.synonymsFor`

Fill in `synonymsFor(rootSegment, projectName)` in `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/ShortcutsSync.kt`. The result must:

- Always include the bare `projectName`.
- When `rootSegment != null`, additionally include the `"<root> <project>"` combination synonym.
- When `rootSegment == null`, return exactly `[projectName]`.
- Never include any of the pronunciation variants reserved for `FALLBACK_SYNONYMS` (no `"pee …"` / `"pie …"` strings).

No deduping rules beyond what the architecture's prose suggests — `synonymsForTest` only asserts containment + ordering for the null-root case.

**Verify:** the four `synonymsFor` cases in `ShortcutsSyncTest` pass.
**Status:** not started

### Step 4: Implement `ShortcutsSync.diff`

Fill in `diff(desired, existing)` in `ShortcutsSync.kt` with a sourceId-keyed reconciliation:

- Group both lists by `shortcutId`.
- For ids only in `desired`: emit an upsert.
- For ids only in `existing`: emit a delete.
- For ids in both: emit an upsert iff the two `DesiredShortcut` instances are not equal (`DesiredShortcut` is a data class, so `==` already covers `rank` / `synonyms` / `pimoteUri` / `capabilityParameter` / `shortLabel` / `longLabel`).
- Otherwise emit nothing for that id.

Return a `SyncOps(toDelete = …, toUpsert = …)`.

**Verify:** the five `diff` cases in `ShortcutsSyncTest` pass — including `diff treats rank, synonyms, pimoteUri, and capabilityParameter as content`.
**Status:** not started

### Step 5: Implement `ShortcutsSync.computeDesiredShortcuts`

Fill in `computeDesiredShortcuts(groups, maxShortcuts)` in `ShortcutsSync.kt`. Build the result in this order:

1. Always start with the fallback shortcut at `rank = 0`:
   - `shortcutId = FALLBACK_SHORTCUT_ID`
   - `shortLabel` and `longLabel` user-visible (the tests only assert `longLabel.startsWith("Call ")` for projects, not the fallback — pick something stable, e.g. `"Pimote"` and `"Call Pimote"`)
   - `capabilityParameter = FALLBACK_PARAMETER`
   - `synonyms = FALLBACK_SYNONYMS`
   - `pimoteUri = null`
2. If `maxShortcuts <= 1`, return just the fallback.
3. Otherwise take `groups.take(maxShortcuts - 1)` (caller pre-sorts by recency) and map each to a `DesiredShortcut` with:
   - `shortcutId = PhoneAccountRules.projectHandleId(group.project.folderPath)`
   - `shortLabel = "<root> <project>"` when `rootSegmentOf` is non-null, else bare basename (mirror Step 2's rule)
   - `longLabel = "Call " + shortLabel`
   - `capabilityParameter = shortLabel` (used by Assistant to bind utterances)
   - `synonyms = synonymsFor(rootSegmentOf(folderPath), folderName)`
   - `pimoteUri = "pimote:" + projectHandleId(folderPath)`
   - `rank = index + 1` (so the fallback stays at rank 0 and projects ascend `1, 2, …`)

Respect `maxShortcuts` strictly — never emit more than `maxShortcuts` total entries.

**Verify:** all `computeDesiredShortcuts` cases in `ShortcutsSyncTest` pass (fallback always present, cap honored, ordering preserved, label/URI/rank shape correct).
**Status:** not started

### Step 6: Implement `ShortcutsSync.resolveByFuzzyMatch`

Fill in `resolveByFuzzyMatch(utterance, projects)` in `ShortcutsSync.kt`. Behavior the tests require:

- Empty `projects` → `null`.
- An exact case-insensitive match against `project.folderName` (or the `"<root> <project>"` form) returns `"pimote:" + projectHandleId(project.folderPath)`.
- An utterance that matches nothing recognisable (`"zzzqqqxxx"`) returns `null`.

Use a small token-based scoring routine (lower-case, split on whitespace, count token overlap with each project's candidate strings — folderName plus the root-prefixed form). Return the best candidate above a sane threshold (e.g. requires at least one shared token of length ≥ 3 and a normalized score above 0.5); otherwise `null`. The threshold isn't asserted directly — tests only exercise exact match and total mismatch — so a simple deterministic scorer is enough.

**Verify:** the three `resolveByFuzzyMatch` cases in `ShortcutsSyncTest` pass.
**Status:** not started

### Step 7: Implement `CallByPimoteUri.placeCall`

Fill in `placeCall(context, pimoteUri, telecom)` in `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/CallByPimoteUri.kt`. The reference implementation already exists inline at `ui/contacts/ContactsScreen.kt:327` — extract that pattern into the shared helper:

1. Validate via `PhoneAccountRules.parseDialUri(pimoteUri)`. Return `false` on `null`.
2. Resolve the `TelecomManager` via `context.getSystemService(Context.TELECOM_SERVICE)`.
3. Build a `PhoneAccountHandle(ComponentName(appContext, PimoteConnectionService::class.java), PIMOTE_SERVICE_HANDLE_ID)`.
4. Convert the `pimote:` URI to an `android.net.Uri` (the existing screen uses `Uri.fromParts(PIMOTE_URI_SCHEME, ssp, null)` — preserve that behavior so `parseDialUri` continues to round-trip).
5. Call `tm.placeCall(uri, Bundle().apply { putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle) })`.
6. Catch `SecurityException` / generic `Throwable`, log via `L.w("Shortcuts", …)`, return `false`. Return `true` on successful dispatch.

The `telecom: TelecomFacade` parameter is currently unused at runtime — the architecture's signature retains it for testability of future paths but production calls go through `TelecomManager` directly to match `ContactsScreen.placeCall`. Leave the parameter; ignore it in the body for now and add a `// telecom seam reserved` comment.

**Verify:** `make android-build` compiles. No JVM unit tests cover this helper; the contact-card and Assistant manual journeys (Step 13) exercise it end-to-end.
**Status:** not started

### Step 8: Implement `AndroidShortcutManagerFacade`

In `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/AndroidShortcutManagerFacade.kt`, replace the three `TODO` bodies with `androidx.core.content.pm.ShortcutManagerCompat` calls.

- `getMaxShortcutCountPerActivity()`: return `ShortcutManagerCompat.getMaxShortcutCountPerActivity(context)`. If the value is < 2, fall back to `15` (architecture's safe default).
- `getDynamicShortcuts()`: read `ShortcutManagerCompat.getDynamicShortcuts(context)` and translate each `ShortcutInfoCompat` back into a `DesiredShortcut`. Use the shortcut's `id` for `shortcutId`, `shortLabel.toString()` / `longLabel.toString()` for the labels, the persisted `capabilityParameter` extra (read from `extras` Bundle keyed by `"capabilityParameter"`) for `capabilityParameter`, the persisted `synonyms` (stringArray extra `"synonyms"`) for `synonyms`, the `"pimoteUri"` extra (nullable) for `pimoteUri`, and `rank` for `rank`. The extras-based round-trip is necessary because `ShortcutInfoCompat` doesn't expose `addCapabilityBinding` parameters via getters.
- `setDynamicShortcuts(shortcuts)`: build a `ShortcutInfoCompat.Builder` per entry with `setShortLabel`, `setLongLabel`, `setRank`, `setLongLived(true)`, `setIntent(...)`, `addCapabilityBinding("actions.intent.CREATE_CALL", "call.participant.name", synonyms)`, and a persistence Bundle (set via `setExtras(PersistableBundle)` if available, else stash on the launch intent extras) that round-trips the four `DesiredShortcut` fields not natively exposed. The launch intent points at `CallByNameActivity` with `participantName` extra equal to `capabilityParameter`. Then call `ShortcutManagerCompat.setDynamicShortcuts(context, list)`.

Intent action and class name must match `mobile/android/app/src/main/res/xml/shortcuts.xml` (`ACTION_VIEW`, `com.pimote.android.shortcuts.CallByNameActivity`).

**Verify:** `make android-build` compiles. Manual journey 9 (Step 13) confirms shortcut population on device.
**Status:** not started

### Step 9: Implement `ShortcutsRunner.start` / `stop`

In `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/ShortcutsRunner.kt`, implement the reconcile loop described in the architecture. Mirror the structure of `ContactSyncRunner.start`:

- Hold a nullable `Job` field.
- `start()`: idempotent. If a job is active, return. Otherwise launch on `scope`:
  ```kotlin
  combine(repository.projects, repository.sessions) { p, s -> p to s }
      .debounce(debounceMs)
      .collect { (projects, sessions) -> runCatching { reconcile(projects, sessions) }
          .onFailure { L.w("Shortcuts", "reconcile failed: ${it.message}", it) } }
  ```
- `stop()`: cancel the job and null it.
- `private fun reconcile(projects, sessions)`:
  1. `val groups = buildSessionProjectGroups(projects, sessions)`
  2. `val cap = max(shortcutManager.getMaxShortcutCountPerActivity(), 2)`
  3. `val desired = ShortcutsSync.computeDesiredShortcuts(groups, cap)`
  4. `val existing = shortcutManager.getDynamicShortcuts()`
  5. If `desired != existing`, call `shortcutManager.setDynamicShortcuts(desired)`.

Add `@FlowPreview @ExperimentalCoroutinesApi` annotations on `start()` (the `debounce` operator requires them, matching `ContactSyncRunner`). Use `kotlinx.coroutines.flow.combine` and `debounce` imports.

**Verify:** `make android-build` compiles. The runner has no JVM unit tests; behavior is exercised via manual journey 9.
**Status:** not started

### Step 10: Implement `CallByNameActivity.onCreate`

In `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/CallByNameActivity.kt`, replace the body of `onCreate` with the App Actions fulfillment trampoline. Keep the activity headless (`finish()` always runs on the same dispatch). Resolution order matches the architecture's `CallByNameActivity` section:

1. Read `participantName = intent.getStringExtra("participantName")?.trim().orEmpty()`.
2. Pull a snapshot from `AppContainer.instance.sessionRepository`: `projects = repo.projects.value`, `sessions = repo.sessions.value`.
3. Resolve to a `pimoteUri: String?` via:
   - If `participantName == ShortcutsSync.FALLBACK_PARAMETER`: pick the most-recently-active project from `buildSessionProjectGroups(projects, sessions).firstOrNull()` and emit `"pimote:" + projectHandleId(folderPath)`. If the list is empty, show a `Toast.makeText(this, "No projects available", LENGTH_SHORT).show()` and finish.
   - Else: search the desired-shortcut set (recompute via `ShortcutsSync.computeDesiredShortcuts(groups, cap)`) for an exact match on `capabilityParameter` and use its `pimoteUri`.
   - Else: `ShortcutsSync.resolveByFuzzyMatch(participantName, projects)`.
   - Else: launch `MainActivity` with `Intent(this, MainActivity::class.java).addFlags(FLAG_ACTIVITY_NEW_TASK)` (defensive) and finish.
4. If a `pimoteUri` was resolved, call `CallByPimoteUri.placeCall(applicationContext, pimoteUri, AppContainer.instance.telecomFacade)`. Always `finish()` immediately after.

Use `super.onCreate(savedInstanceState)` first, then the resolution logic, then `finish()`.

**Verify:** `make android-build` compiles. Manual journey covers `"Hey Google, call Pimote"` and `"Hey Google, call <project>"` end-to-end (Step 13).
**Status:** not started

### Step 11: Implement `CallByDataRowActivity.onCreate`

In `mobile/android/app/src/main/kotlin/com/pimote/android/shortcuts/CallByDataRowActivity.kt`, replace the body of `onCreate` with the contact-card `ACTION_VIEW` trampoline:

1. Read `val rowUri = intent.data` — the `ContactsContract.Data` row URI delivered by the system contact card.
2. If `rowUri == null`, `finish()` and return.
3. Query `contentResolver.query(rowUri, arrayOf(ContactsContract.Data.DATA1), null, null, null)`. Read `data1` from the first row.
4. If non-null and parseable via `PhoneAccountRules.parseDialUri(...)` (i.e. starts with `pimote:` and decodes), call `CallByPimoteUri.placeCall(applicationContext, data1, AppContainer.instance.telecomFacade)`.
5. Always `finish()` (regardless of dispatch outcome). Wrap the cursor in `use { … }` so it closes.

No runtime permission prompt here — the activity is invoked from the system contact-card UI, which holds contacts permission on our behalf (and the app already requests `READ_CONTACTS` at startup). Failures log via `L.w("Shortcuts", …)`.

**Verify:** `make android-build` compiles. Manual journey: tap the call action button on a Pimote contact card and the `pimote:project:...` URI dispatches via Telecom (Step 13).
**Status:** not started

### Step 12: Wire `ShortcutsRunner` into `AppContainer`

In `mobile/android/app/src/main/kotlin/com/pimote/android/app/AppContainer.kt`, the `shortcutManagerFacade` and `shortcutsRunner` fields are already constructed. Add `start()` for `shortcutsRunner` alongside the existing `contactSyncRunner.start()` invocation in the surrounding bootstrap (search for where `ContactSyncRunner` is started — likely `MainActivity.onCreate` or a `PimoteApp.onCreate`/`AppContainer.init`). Mirror the existing call sites symmetrically: wherever `contactSyncRunner.start()` runs, also call `shortcutsRunner.start()`; wherever `contactSyncRunner.stop()` runs (if any), pair it with `shortcutsRunner.stop()`.

If `ContactSyncRunner` is not currently started by `AppContainer.init` (the `init` block above only handles `InCallActivity` launch), grep `mobile/android/app/src/main/kotlin/com/pimote/android` for `contactSyncRunner.start` to find the actual start site and wire `shortcutsRunner.start()` next to it.

**Verify:** `make android-build` compiles. After install, `ShortcutManagerCompat.getDynamicShortcuts(context)` reflects the project list (manual confirmation via journey 9).
**Status:** not started

### Step 13: Run the manual journey for assistant-callable projects

Extend `tools/manual-test/PLAN.md` with a new journey 9 covering the user-visible surfaces this plan introduces. Steps to capture:

1. Boot the app, ensure `READ_CONTACTS` / `WRITE_CONTACTS` are granted, wait for the contact + shortcut sync debounce (~2 s).
2. From the system Contacts app, locate a Pimote project contact, open its card, confirm the call action button is present, tap it, and observe the call dispatching through `PimoteConnectionService` (in-app `InCallActivity` opens).
3. With Assistant: say `"Hey Google, call Pimote"`. Confirm the fallback shortcut resolves to the most-recently-active project and the call dispatches.
4. Say `"Hey Google, call <project name>"` for one of the top-N projects. Confirm direct resolution.
5. Say `"Hey Google, call <utterance close to a project name>"`. Confirm fuzzy-match resolution.
6. Confirm long-tail projects beyond the system shortcut cap are still callable from the contact-card surface (step 2 against an off-list project).

Log any deviations as findings; this journey is the integration test that the unit tests can't cover (no Telecom / ShortcutManager / Assistant on JVM).

**Verify:** `make android-test` is green; the journey above passes on a physical device.
**Status:** not started

