# Plan: Android — Assistant/Gemini-discoverable Pimote contacts

## Context

Pimote currently syncs sessions/projects into `ContactsContract` under a Pimote `AccountManager` Account, with a `Phone` data row holding a `pimote:session:<id>` / `pimote:project:<base64>` URI (DR-019). The contacts exist but Google Assistant / Gemini ("Hey Google, call <session>") don't see them as callable, and the system contact card doesn't render a "Call via Pimote" affordance. We don't have real phone numbers — we have a `pimote:` URI scheme owned by our self-managed Telecom `PhoneAccount`. Mirror the WhatsApp/Signal/Skype pattern: a custom callable MIME type advertised through a `CONTACTS_STRUCTURE` resource on the account authenticator, with the account also surfaced as a contacts SyncAdapter so the platform treats it as a first-class contacts source.

No brainstorm document — direction was given directly.

## Architecture

### Impacted Modules

- **Android Client / contacts** (`mobile/android/app/src/main/kotlin/com/pimote/android/contacts/`)
  - `ContactsSync` — `DesiredContact` keeps `sourceId`, `displayName`, `pimoteUri`, `summary`, but the diff layer no longer treats the URI as a `Phone.NUMBER`. The `ExistingContact` read path also moves off `Phone`. Pure-function shape is unchanged; only the row representation it describes changes.
  - `ContactSyncRunner` — write/read paths switch from `CommonDataKinds.Phone` to a custom MIME row (see Interfaces). On insert, also stamps `RawContacts.RAW_CONTACT_IS_USER_PROFILE = 0`, ensures `IN_VISIBLE_GROUP = 1` on the aggregated row (or via `Settings` row for the account), and sets `Data.IS_PRIMARY = 1` on the callable row so it's chosen by default. `ensureAccount()` additionally calls `ContentResolver.setIsSyncable(account, ContactsContract.AUTHORITY, 1)` (already present) and registers a `Settings` row with `UNGROUPED_VISIBLE = 1` for the Pimote account so contacts appear in the default contacts directory without group membership.

- **Android Client / accounts** (`mobile/android/app/src/main/kotlin/com/pimote/android/accounts/`)
  - `PimoteAuthenticatorService` (manifest declaration only) — gains a second `<meta-data android:name="android.provider.CONTACTS_STRUCTURE" android:resource="@xml/contacts" />` entry alongside the existing `AccountAuthenticator` meta-data.

- **Android Client / manifest + resources** (`mobile/android/app/src/main/AndroidManifest.xml`, `res/xml/`)
  - New `<service>` entry for the SyncAdapter shim (see New Modules), wired with `android.content.SyncAdapter` intent filter and a `SyncAdapter` meta-data referencing `res/xml/syncadapter.xml`.
  - New `res/xml/contacts.xml` — `<ContactsAccountType>` describing one `<ContactsDataKind>` for the custom callable MIME, including the `mimeType`, `icon`, `summaryColumn`, `detailColumn`, and the `actionInflate` / `Intent` action that fires `ACTION_CALL` (or `ACTION_VIEW`) on the row's `pimote:` URI.
  - New `res/xml/syncadapter.xml` — declares `contentAuthority = "com.android.contacts"`, `accountType = "com.pimote.android.account"`, `userVisible = true`, `supportsUploading = false`.

- **Android Client / telephony** (no code change)
  - `PhoneAccountRegistrarImpl`, `AndroidTelecomFacade`, `PimoteConnectionService`, `PhoneAccountRules.parseDialUri` are unchanged. The custom MIME's call intent invokes `placeCall("pimote:<sourceId>")`; Telecom routes via the existing `setSupportedUriSchemes(["pimote"])` to our single self-managed PhoneAccount, and `PimoteConnectionService.onCreateOutgoingConnection` parses the URI as today.

### New Modules

- **`contacts/PimoteSyncAdapter` + `contacts/PimoteSyncAdapterService`** — minimal `AbstractThreadedSyncAdapter` whose `onPerformSync` is a no-op (the real reconciliation is driven by `ContactSyncRunner` reacting to `SessionRepository`, not by the platform sync framework). Exists purely so the platform recognizes the Pimote account as a contacts-syncing account, which gates contact visibility in some pickers and surfaces the account under Settings → Accounts → Pimote → Contacts. Lives next to `ContactSyncRunner` under `contacts/`.

### Interfaces

**Custom callable MIME**

- Constant defined once (likely `PhoneAccountRules` or a new `PimoteContactsContract` object):
  ```kotlin
  const val MIME_CALLABLE = "vnd.android.cursor.item/vnd.com.pimote.android.call"
  ```
- Data row layout (column → semantic):
  - `Data.MIMETYPE` = `MIME_CALLABLE`
  - `Data.DATA1` = pimote URI (`pimote:session:<id>` / `pimote:project:<base64>`) — used as the dial target by the action intent and as the stable equality key during diff
  - `Data.DATA2` = short detail label ("Pimote session" / "Pimote project")
  - `Data.DATA3` = summary text (`DesiredContact.summary`) — the line shown under the action in the contact card
  - `Data.IS_PRIMARY` = 1 on insert
- Behavior contract: tapping the row, or any system component (Assistant, dialer search, Auto contact picker) issuing the declared call action against the row, must fire an intent that resolves to our `PhoneAccount` via `pimote:` URI scheme routing — i.e. it ultimately invokes `TelecomManager.placeCall(Uri.parse(DATA1), …)` or `Intent(ACTION_CALL, Uri.parse(DATA1))`.

**`res/xml/contacts.xml` shape**

```xml
<ContactsAccountType xmlns:android="http://schemas.android.com/apk/res/android">
  <ContactsDataKind
      android:mimeType="vnd.android.cursor.item/vnd.com.pimote.android.call"
      android:icon="@drawable/ic_call_outlined"
      android:summaryColumn="data2"
      android:detailColumn="data3"
      android:detailSocialSummary="true" />
</ContactsAccountType>
```

Plus an `actionInflate` / nested `Intent` element binding `android.intent.action.CALL` to `data1` so the contact card and Assistant route through Telecom.

**`ContactsSync` (pure)**

- `DesiredContact` unchanged (`sourceId`, `displayName`, `pimoteUri`, `summary`).
- `ExistingContact` unchanged in field set; the value of `pimoteUri` is now read from the custom-MIME row instead of the `Phone.NUMBER` row.
- `diff(desired, existing)` semantics unchanged — equality on `(displayName, pimoteUri)`.

**`ContactSyncRunner`**

- `readContactDataFor(rawContactId)` switches the MIME match arm: previously
  `Phone.CONTENT_ITEM_TYPE → pimoteUri = data1`; now `MIME_CALLABLE → pimoteUri = data1`. `StructuredName` arm unchanged.
- `insertRawContactOps(d)` builds three operations:
  1. `RawContacts` insert with `ACCOUNT_NAME`/`ACCOUNT_TYPE`/`SOURCE_ID` (unchanged).
  2. `Data` insert: `StructuredName.DISPLAY_NAME = d.displayName` (unchanged).
  3. `Data` insert: `MIMETYPE = MIME_CALLABLE`, `DATA1 = d.pimoteUri`, `DATA2 = "Pimote"`, `DATA3 = d.summary`, `IS_PRIMARY = 1`.
- `updateRawContactOps(u)` updates the `MIME_CALLABLE` row's `DATA1`/`DATA3` (and `StructuredName.DISPLAY_NAME` row), not `Phone`.
- `ensureAccount()` additionally writes a `Settings` row (`Settings.CONTENT_URI`, `CALLER_IS_SYNCADAPTER=true`) for `(account.name, account.type)` with `UNGROUPED_VISIBLE = 1` and `SHOULD_SYNC = 1`.

**SyncAdapter shim**

```kotlin
class PimoteSyncAdapter(context: Context, autoInitialize: Boolean)
  : AbstractThreadedSyncAdapter(context, autoInitialize) {
    override fun onPerformSync(
        account: Account, extras: Bundle,
        authority: String, provider: ContentProviderClient,
        result: SyncResult,
    ) { /* no-op; reconciliation lives in ContactSyncRunner */ }
}

class PimoteSyncAdapterService : Service() {
    override fun onBind(intent: Intent): IBinder =
        PimoteSyncAdapter(this, /* autoInitialize = */ true).syncAdapterBinder
}
```

Manifest entry: `<service>` with `android.content.SyncAdapter` intent filter and `meta-data` referencing `@xml/syncadapter`. Behavioral contract: presence is sufficient; no sync request is ever issued by Pimote and `setSyncAutomatically(false)` remains.

### DR Supersessions

- **DR-019** (Sessions and projects sync into ContactsContract; one PhoneAccount) — **partially superseded**. The single-PhoneAccount + AccountManager-Account + URI-scheme-routing core stays. What's reversed:
  - Data row representation: `CommonDataKinds.Phone` with `Phone.NUMBER = pimote:…` → custom MIME `vnd.android.cursor.item/vnd.com.pimote.android.call` with `DATA1 = pimote:…`, advertised to the platform via a `CONTACTS_STRUCTURE` resource on the authenticator.
  - "No SyncAdapter" decision: a minimal no-op `AbstractThreadedSyncAdapter` is added so the platform treats the Pimote account as a first-class contacts source. The original rationale (no background sync needed) still holds — the shim performs no work; it's pure registration metadata.
  - Reason: DR-019's representation gave us contact rows but not an Assistant/Gemini-recognizable callable affordance. Phone numbers in non-`tel:` schemes don't get picked up by Assistant's "call X" voice-intent resolution, and without `CONTACTS_STRUCTURE` the system contact card has no per-MIME action to render.

## Tests

**Pre-test-write commit:** `c4abb357d7160f6d9b1ec181afc1edd0b8b6e15d`

### Interface Files

- `mobile/android/app/src/main/kotlin/com/pimote/android/contacts/PimoteContactsContract.kt` — defines the `MIME_CALLABLE` constant, the `LABEL` constant, the `CallableRow` data class describing the column-by-column shape of the callable data row (`mimeType`, `data1`, `data2`, `data3`, `isPrimary`), and the pure `callableRowFor(DesiredContact): CallableRow` mapping (body is `TODO()`).
- `mobile/android/app/src/main/kotlin/com/pimote/android/contacts/PimoteSyncAdapter.kt` — `AbstractThreadedSyncAdapter` subclass with a no-op `onPerformSync`. The empty body is the contract, not a placeholder.
- `mobile/android/app/src/main/kotlin/com/pimote/android/contacts/PimoteSyncAdapterService.kt` — `Service` skeleton that constructs the adapter on `onCreate` and returns `syncAdapterBinder` from `onBind`. Pure Android plumbing; no business logic.

### Test Files

- `mobile/android/app/src/test/kotlin/com/pimote/android/contacts/PimoteContactsContractTest.kt` — pins the MIME string, the `LABEL` constant, and the column-by-column behavior of `callableRowFor` for both session and project desired contacts.

### Behaviors Covered

#### PimoteContactsContract

- The `MIME_CALLABLE` constant is exactly `vnd.android.cursor.item/vnd.com.pimote.android.call`. This must stay in lockstep with `res/xml/contacts.xml`.
- The `LABEL` constant is `"Pimote"`.
- `callableRowFor` produces a row whose `mimeType` is `MIME_CALLABLE`.
- `callableRowFor` maps the desired contact's `pimoteUri` verbatim into `data1` for both session and project URIs.
- `callableRowFor` writes `LABEL` into `data2`.
- `callableRowFor` writes the desired contact's `summary` verbatim into `data3`.
- `callableRowFor` marks the row as primary (`isPrimary == 1`) so the system contact card and Assistant pick it as the default action.

#### Out of unit-test scope

- `PimoteSyncAdapter` / `PimoteSyncAdapterService`: pure Android service plumbing; behavior is the platform binding lifecycle. Verified manually on-device, consistent with the existing project convention that `ContactSyncRunner` and other Android-glue classes are not unit-tested.
- `ContactSyncRunner` row representation switch from `Phone` → `MIME_CALLABLE` and the new `Settings` row write: covered by the same convention. The pure mapping it now consumes (`callableRowFor`) is unit-tested above.
- `res/xml/contacts.xml`, `res/xml/syncadapter.xml`, manifest meta-data: declarative XML, exercised by the platform at runtime.
