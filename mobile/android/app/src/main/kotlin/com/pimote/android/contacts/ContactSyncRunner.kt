package com.pimote.android.contacts

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.ContactsContract
import com.pimote.android.session.SessionRepository
import com.pimote.android.util.L
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch

/**
 * Observes [SessionRepository] and reconciles its state into the system
 * contacts database under the "Pimote" Account.
 *
 * Replaces the per-session/project `PhoneAccountRegistrar` (which hit
 * Telecom's 10-account-per-package cap and was architecturally wrong —
 * PhoneAccounts are calling *services*, not contacts). See DR-019.
 *
 * - Ensures the "Pimote" `Account` exists in `AccountManager`. The
 *   AccountAuthenticator is otherwise a stub (no credentials).
 * - On every emission of the combined `projects` + `sessions` flow,
 *   debounced 2 seconds, computes the desired contact set and diffs it
 *   against current ContactsContract entries owned by the Pimote Account.
 *   Applies the diff via a `ContentProviderOperation` batch.
 *
 * URI scheme on inserted contacts: each contact's "phone number" is
 * `pimote:session:<id>` or `pimote:project:<base64url(folderPath)>`.
 * Telecom routes calls to those URIs to the Pimote PhoneAccount because
 * `AndroidTelecomFacade` declares `setSupportedUriSchemes(["pimote"])`.
 *
 * No `WRITE_CONTACTS` runtime permission is required because all writes
 * carry `CALLER_IS_SYNCADAPTER=true` and target rows owned by the Pimote
 * Account — the system trusts apps to mutate rows under their own Account.
 */
class ContactSyncRunner(
    private val context: Context,
    private val repository: SessionRepository,
    private val scope: CoroutineScope,
    private val debounceMs: Long = 2_000L,
) {
    // Held in a StateFlow rather than a raw mutable `Job?` field so the
    // run/stop transitions go through an explicit, atomic value write.
    private val runner = MutableStateFlow<CoroutineScope?>(null)

    private val account: Account = Account(
        context.getString(com.pimote.android.R.string.account_name),
        context.getString(com.pimote.android.R.string.account_type),
    )

    @FlowPreview
    @ExperimentalCoroutinesApi
    fun start() {
        if (runner.value != null) return
        ensureAccount()
        val child = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
        runner.value = child
        child.launch {
            combine(repository.projects, repository.sessions) { p, s -> p to s }
                .debounce(debounceMs)
                .collect { (projects, _) ->
                    runCatching { reconcile(projects) }
                        .onFailure { L.w("ContactsSync", "reconcile failed: ${it.message}", it) }
                }
        }
    }

    fun stop() {
        runner.value?.cancel()
        runner.value = null
    }

    private fun ensureAccount() {
        val am = AccountManager.get(context)
        val existing = am.getAccountsByType(account.type)
        if (existing.isEmpty()) {
            val added = am.addAccountExplicitly(account, null, null)
            L.i("ContactsSync", "addAccountExplicitly result=$added")
            // Tell the platform our Account is contacts-syncable so contacts ownership is recognized.
            ContentResolver.setIsSyncable(account, ContactsContract.AUTHORITY, 1)
            ContentResolver.setSyncAutomatically(account, ContactsContract.AUTHORITY, false)
        }
        // Idempotent: ensure a ContactsContract.Settings row exists for our
        // account with UNGROUPED_VISIBLE=1 so synced contacts roll up into
        // the default contacts directory (and Assistant search) without
        // requiring group membership. Failure here must not crash account
        // setup; we just log and proceed.
        runCatching { ensureContactsSettingsRow() }
            .onFailure { L.w("ContactsSync", "ensureContactsSettingsRow failed: ${it.message}", it) }
    }

    private fun ensureContactsSettingsRow() {
        val settingsUri = ContactsContract.Settings.CONTENT_URI.buildUpon()
            .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
            .build()
        val selection =
            "${ContactsContract.Settings.ACCOUNT_NAME} = ? AND ${ContactsContract.Settings.ACCOUNT_TYPE} = ?"
        val args = arrayOf(account.name, account.type)
        val resolver = context.contentResolver
        val present = resolver.query(
            ContactsContract.Settings.CONTENT_URI,
            arrayOf(ContactsContract.Settings.ACCOUNT_NAME),
            selection,
            args,
            null,
        )?.use { it.moveToFirst() } ?: false
        if (present) {
            val values = android.content.ContentValues().apply {
                put(ContactsContract.Settings.UNGROUPED_VISIBLE, 1)
                put(ContactsContract.Settings.SHOULD_SYNC, 1)
            }
            resolver.update(settingsUri, values, selection, args)
        } else {
            val values = android.content.ContentValues().apply {
                put(ContactsContract.Settings.ACCOUNT_NAME, account.name)
                put(ContactsContract.Settings.ACCOUNT_TYPE, account.type)
                put(ContactsContract.Settings.UNGROUPED_VISIBLE, 1)
                put(ContactsContract.Settings.SHOULD_SYNC, 1)
            }
            resolver.insert(settingsUri, values)
        }
    }

    private fun reconcile(
        projects: List<com.pimote.android.session.ProjectMeta>,
    ) {
        val desired = ContactsSync.computeDesiredContacts(projects)
        val existing = readExistingContacts()
        val ops = ContactsSync.diff(desired, existing)

        if (ops.toInsert.isEmpty() && ops.toDelete.isEmpty() && ops.toUpdate.isEmpty()) return

        L.i(
            "ContactsSync",
            "reconcile: desired=${desired.size} existing=${existing.size} " +
                "insert=${ops.toInsert.size} delete=${ops.toDelete.size} update=${ops.toUpdate.size}",
        )

        val batch = ArrayList<ContentProviderOperation>()
        for (raw in ops.toDelete) batch += deleteRawContactOps(raw)
        for (u in ops.toUpdate) batch += updateRawContactOps(u)
        // Back-reference indices in ContentProviderOperation.applyBatch are
        // the absolute position in the submitted op list, not relative per
        // contact. We must capture the index of each RawContacts insert and
        // use it as the back-ref for that contact's data rows. (Hardcoding 0
        // attached every contact's name/callable rows to the first inserted
        // raw contact.)
        for (d in ops.toInsert) {
            val rawRefIdx = batch.size
            batch += insertRawContactOps(d, rawRefIdx)
        }

        if (batch.isNotEmpty()) {
            try {
                context.contentResolver.applyBatch(ContactsContract.AUTHORITY, batch)
            } catch (t: Throwable) {
                L.w("ContactsSync", "applyBatch failed: ${t.message}", t)
            }
        }
    }

    // ---- ContactsContract reads / writes ------------------------------------

    private val syncAuthority: Uri =
        ContactsContract.RawContacts.CONTENT_URI.buildUpon()
            .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(ContactsContract.RawContacts.ACCOUNT_NAME, account.name)
            .appendQueryParameter(ContactsContract.RawContacts.ACCOUNT_TYPE, account.type)
            .build()

    private val dataAuthority: Uri =
        ContactsContract.Data.CONTENT_URI.buildUpon()
            .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
            .build()

    private fun readExistingContacts(): List<ContactsSync.ExistingContact> {
        val out = ArrayList<ContactsSync.ExistingContact>()
        val cursor = context.contentResolver.query(
            ContactsContract.RawContacts.CONTENT_URI,
            arrayOf(
                ContactsContract.RawContacts._ID,
                ContactsContract.RawContacts.SOURCE_ID,
            ),
            "${ContactsContract.RawContacts.ACCOUNT_TYPE} = ? AND ${ContactsContract.RawContacts.ACCOUNT_NAME} = ? AND ${ContactsContract.RawContacts.DELETED} = 0",
            arrayOf(account.type, account.name),
            null,
        ) ?: return emptyList()
        cursor.use { c ->
            val idIdx = c.getColumnIndexOrThrow(ContactsContract.RawContacts._ID)
            val srcIdx = c.getColumnIndexOrThrow(ContactsContract.RawContacts.SOURCE_ID)
            while (c.moveToNext()) {
                val rawId = c.getLong(idIdx)
                val sourceId = c.getString(srcIdx) ?: continue
                val (display, uri) = readContactDataFor(rawId)
                // Classify (pure): a row missing EITHER the StructuredName or the
                // callable data row is an orphan (failed insert, or an external
                // edit that deleted one row). It is surfaced under an
                // "orphan:<rawId>" sourceId so diff() deletes it and the canonical
                // contact is reinserted fresh — an in-place update can't repair a
                // missing data row. See ContactsSync.classifyExisting.
                out.add(ContactsSync.classifyExisting(sourceId, rawId, display, uri))
            }
        }
        return out
    }

    private fun readContactDataFor(rawContactId: Long): Pair<String?, String?> {
        var displayName: String? = null
        var pimoteUri: String? = null
        val cursor = context.contentResolver.query(
            ContactsContract.Data.CONTENT_URI,
            arrayOf(
                ContactsContract.Data.MIMETYPE,
                ContactsContract.Data.DATA1,
            ),
            "${ContactsContract.Data.RAW_CONTACT_ID} = ?",
            arrayOf(rawContactId.toString()),
            null,
        ) ?: return null to null
        cursor.use { c ->
            val mimeIdx = c.getColumnIndexOrThrow(ContactsContract.Data.MIMETYPE)
            val dataIdx = c.getColumnIndexOrThrow(ContactsContract.Data.DATA1)
            while (c.moveToNext()) {
                when (c.getString(mimeIdx)) {
                    ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE -> displayName = c.getString(dataIdx)
                    PimoteContactsContract.MIME_CALLABLE -> pimoteUri = c.getString(dataIdx)
                }
            }
        }
        return displayName to pimoteUri
    }

    private fun deleteRawContactOps(rawContactId: Long): List<ContentProviderOperation> = listOf(
        ContentProviderOperation.newDelete(
            ContactsContract.RawContacts.CONTENT_URI.buildUpon()
                .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
                .build(),
        )
            .withSelection("${ContactsContract.RawContacts._ID} = ?", arrayOf(rawContactId.toString()))
            .build(),
    )

    private fun insertRawContactOps(
        d: ContactsSync.DesiredContact,
        rawIndex: Int,
    ): List<ContentProviderOperation> {
        val callable = PimoteContactsContract.callableRowFor(d)
        return listOf(
            ContentProviderOperation.newInsert(syncAuthority)
                .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, account.name)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, account.type)
                .withValue(ContactsContract.RawContacts.SOURCE_ID, d.sourceId)
                .build(),
            ContentProviderOperation.newInsert(dataAuthority)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIndex)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, d.displayName)
                .build(),
            ContentProviderOperation.newInsert(dataAuthority)
                .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawIndex)
                .withValue(ContactsContract.Data.MIMETYPE, callable.mimeType)
                .withValue(ContactsContract.Data.DATA1, callable.data1)
                .withValue(ContactsContract.Data.DATA2, callable.data2)
                .withValue(ContactsContract.Data.DATA3, callable.data3)
                .withValue(ContactsContract.Data.IS_PRIMARY, callable.isPrimary)
                .build(),
        )
    }

    private fun updateRawContactOps(u: ContactsSync.UpdatePair): List<ContentProviderOperation> {
        val rawId = u.rawContactId
        val d = u.desired
        val callable = PimoteContactsContract.callableRowFor(d)
        return listOf(
            ContentProviderOperation.newUpdate(dataAuthority)
                .withSelection(
                    "${ContactsContract.Data.RAW_CONTACT_ID} = ? AND ${ContactsContract.Data.MIMETYPE} = ?",
                    arrayOf(rawId.toString(), ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE),
                )
                .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, d.displayName)
                .build(),
            ContentProviderOperation.newUpdate(dataAuthority)
                .withSelection(
                    "${ContactsContract.Data.RAW_CONTACT_ID} = ? AND ${ContactsContract.Data.MIMETYPE} = ?",
                    arrayOf(rawId.toString(), PimoteContactsContract.MIME_CALLABLE),
                )
                .withValue(ContactsContract.Data.DATA1, callable.data1)
                .withValue(ContactsContract.Data.DATA3, callable.data3)
                .build(),
        )
    }
}
