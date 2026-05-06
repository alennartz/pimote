# DR-023: Pimote contacts as Assistant-discoverable callable-MIME rows

## Status

Accepted

Supersedes [DR-019](DR-019-sessions-and-projects-as-contactscontract-contacts.md), deleted at commit `4ddefd8529d111e6452071cc7c6874d8670461b9`.

## Context

DR-019 chose ContactsContract sync over per-session PhoneAccounts (DR-018) so a single Pimote PhoneAccount could service unlimited targets via `pimote:` URI-scheme routing. The structural call — one PhoneAccount, AccountManager Account-owned contact rows, URI-scheme dispatch — held up. Three things did not:

1. **The contact rows weren't callable from Assistant or the system contact card.** DR-019 stored the dial URI in a `Phone.NUMBER` row with `TYPE_OTHER`. Phone numbers in non-`tel:` schemes don't get picked up by Assistant's "call X" voice-intent resolution, and without a `CONTACTS_STRUCTURE` resource the platform has no per-MIME action to render on the contact card. We had visible contacts but no calling affordance — exactly the use case the work existed to enable.
2. **`CALLER_IS_SYNCADAPTER=true` does not waive contacts runtime permissions for arbitrary callers.** DR-019 claimed it did. It only relaxes permission checks when the system holds the SyncAdapter binder identity (i.e. the caller is bound through the platform sync framework). When `ContactSyncRunner` writes from the Application process directly — which it does, because contacts change live with WS events and the platform sync framework's cadence is wrong for that — `READ_CONTACTS` / `WRITE_CONTACTS` are still enforced at the caller's UID.
3. **Per-session contact rows pollute the system contacts list.** DR-019 synced both projects and sessions. A typical user has dozens to hundreds of sessions, most of them transient or unnamed; surfacing each as a separate "contact" produces a wall of no-name entries in the system Contacts app and dialer search.

## Decision

**Keep DR-019's structural choices; change the row representation, register a SyncAdapter shim for visibility, sync projects only, and declare the runtime permissions DR-019 wrongly claimed weren't needed.**

Concretely:

- **Custom callable MIME instead of `Phone`.** The data row owned by each Pimote contact is now `vnd.android.cursor.item/vnd.com.pimote.android.call` with `DATA1 = pimote:<sourceId>`, `DATA2 = "Pimote"`, `DATA3 = summary`, `IS_PRIMARY = 1`. The MIME constant lives in `PimoteContactsContract.MIME_CALLABLE` and the row shape is produced by the pure `callableRowFor(DesiredContact)` mapping. The MIME string must stay in lockstep with `res/xml/contacts.xml`.
- **`CONTACTS_STRUCTURE` resource on the authenticator.** `res/xml/contacts.xml` declares one `<ContactsAccountType>` with one `<ContactsDataKind>` for the callable MIME (icon, summaryColumn=data2, detailColumn=data3). The Pimote `AccountAuthenticator` service in the manifest carries a second `<meta-data android:name="android.provider.CONTACTS_STRUCTURE" android:resource="@xml/contacts" />` alongside the existing AccountAuthenticator entry. This is what makes the platform render a per-MIME action on the contact card and lets Assistant resolve the row as a callable target.
- **Telecom routing unchanged.** Tapping the row, or Assistant firing `ACTION_CALL` with `data1`, lands on Telecom's `pimote:`-scheme dispatch, which routes to our single self-managed PhoneAccount and into `PimoteConnectionService.onCreateOutgoingConnection` exactly as before. No nested `<Intent>` element is required in `contacts.xml`.
- **No-op `AbstractThreadedSyncAdapter` shim.** `PimoteSyncAdapter` + `PimoteSyncAdapterService` register the Pimote account as a first-class contacts SyncAdapter via an `android.content.SyncAdapter` intent filter and `res/xml/syncadapter.xml`. `onPerformSync` is empty — reconciliation still lives in `ContactSyncRunner` reacting to `SessionRepository`. The shim's only purpose is platform metadata: some pickers gate visibility on whether the account is registered as a contacts sync source, and Settings → Accounts → Pimote → Contacts only renders the user-visible "Contacts" entry when a SyncAdapter is registered. `setSyncAutomatically(false)` remains.
- **`ContactsContract.Settings` row.** `ensureAccount()` writes (idempotent insert-or-update) a row in `Settings.CONTENT_URI` for `(account.name, account.type)` with `UNGROUPED_VISIBLE = 1` and `SHOULD_SYNC = 1`, so Pimote contacts roll into the default contacts directory without group membership — which is what Assistant actually searches.
- **Projects only, sessions excluded.** `ContactsSync.computeDesiredContacts` produces one `DesiredContact` per project (sourceId = `project:<base64url(folderPath)>`, summary = "Call <prefix>"). Sessions no longer become system contacts. Calling a project URI starts (or resumes) a session in that folder, which is the right granularity for a voice-driven affordance.
- **`READ_CONTACTS` / `WRITE_CONTACTS` declared and prompted.** Both runtime ("dangerous") permissions are in the manifest. `MainActivity`'s first-run flow adds them to the existing permissions request alongside `RECORD_AUDIO` / `BLUETOOTH_CONNECT`.
- **Account-authenticator icon.** `res/xml/account_authenticator.xml` references `@drawable/ic_call_outlined` (not the launcher mipmap) so the icon renders correctly at the small sizes Settings → Accounts uses.

Rejected alternatives:

- **Keep `Phone.NUMBER` and rely on Assistant/Telecom URI handling.** Verified empirically: Assistant's voice-intent resolution does not match `Phone` rows whose `NUMBER` is a non-`tel:` URI, and the system contact card renders no action for them. The per-MIME `<ContactsDataKind>` declaration is the platform's contract for exposing a custom calling action, and there's no shortcut around it.
- **Embed an `<Intent>` element in `contacts.xml` binding `ACTION_CALL` to `data1`.** Tried; not required. Telecom's URI-scheme routing on `setSupportedUriSchemes(["pimote"])` already dispatches `ACTION_CALL` correctly. Kept the resource minimal; can revisit if a future device surface needs an explicit intent binding.
- **Skip the SyncAdapter shim.** This is what DR-019 chose. Without the shim some surfaces hide the contacts and Settings → Accounts → Pimote shows no Contacts entry. The original "no background sync needed" rationale still holds — the shim is no-op — so the cost is purely registration boilerplate.
- **Keep CALLER_IS_SYNCADAPTER and skip the runtime permissions.** Doesn't work; the system enforces at the caller's UID when the caller isn't bound as a SyncAdapter. We could re-architect so all writes go through the platform sync framework, but that loses the "contacts update live with WS events" property and adds a separate sync-trigger machinery for no real gain.
- **Sync sessions as well as projects.** What DR-019 did. Pollutes the contacts list with many no-name entries and offers little value: the typical session is short-lived and addressable through its project anyway.

## Consequences

- **Assistant / Gemini "call &lt;project&gt;" works.** The voice intent resolves to the callable-MIME row, fires `ACTION_CALL` with the row's `pimote:` URI, and lands on our PhoneAccount via Telecom's URI-scheme dispatch.
- **System contact card shows a per-MIME "Pimote" action.** Tapping it places the call.
- **Settings → Accounts → Pimote → Contacts is user-visible.** The SyncAdapter shim makes the account a first-class contacts source.
- **First-run permissions UX gains two prompts.** `READ_CONTACTS` and `WRITE_CONTACTS` ride along with the existing mic/Bluetooth prompts. Denial is not currently handled gracefully — `ContactSyncRunner` will fail and log; revisit if denial becomes a real-world case.
- **Contacts list is one entry per project, not per session.** A user with one project sees one "Pimote: &lt;project&gt;" contact regardless of how many sessions live underneath. The ergonomics of "what do I call to talk to the pi" line up with the project as the addressable unit.
- **The MIME string is now a cross-component contract.** `PimoteContactsContract.MIME_CALLABLE`, `res/xml/contacts.xml`, and any future external consumer (e.g. an exported intent filter) all have to agree on `vnd.android.cursor.item/vnd.com.pimote.android.call`. The Kotlin constant is unit-pinned in `PimoteContactsContractTest`.
- **No-op SyncAdapter is a permanent piece of plumbing.** Future me will wonder why it exists — this DR is the answer. It is not a placeholder for "real" sync work; the reconciliation model is correct as is.
- **DR-019's `Phone.NUMBER` row representation, "no `WRITE_CONTACTS`/`READ_CONTACTS`" claim, and "no SyncAdapter" claim are all explicitly reversed.** The structural choices it made (one PhoneAccount, AccountManager Account ownership, URI-scheme routing, pure-function `ContactsSync` + `PhoneAccountRules`) carry forward unchanged.
