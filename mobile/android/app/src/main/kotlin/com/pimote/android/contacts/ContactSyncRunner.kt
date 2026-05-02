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
    private var job: Job? = null

    private val account: Account = Account(
        context.getString(com.pimote.android.R.string.account_name),
        context.getString(com.pimote.android.R.string.account_type),
    )

    @FlowPreview
    @ExperimentalCoroutinesApi
    fun start() {
        if (job?.isActive == true) return
        ensureAccount()
        job = scope.launch {
            combine(repository.projects, repository.sessions) { p, s -> p to s }
                .debounce(debounceMs)
                .collect { (projects, sessions) ->
                    runCatching { reconcile(projects, sessions) }
                        .onFailure { L.w("ContactsSync", "reconcile failed: ${it.message}", it) }
                }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
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
    }

    private fun reconcile(
        projects: List<com.pimote.android.session.ProjectMeta>,
        sessions: List<com.pimote.android.session.SessionMeta>,
    ) {
        val desired = ContactsSync.computeDesiredContacts(projects, sessions)
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
        for (d in ops.toInsert) batch += insertRawContactOps(d)

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
                out.add(
                    ContactsSync.ExistingContact(
                        sourceId = sourceId,
                        rawContactId = rawId,
                        displayName = display.orEmpty(),
                        pimoteUri = uri.orEmpty(),
                    ),
                )
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
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE -> pimoteUri = c.getString(dataIdx)
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

    private fun insertRawContactOps(d: ContactsSync.DesiredContact): List<ContentProviderOperation> {
        val rawIndex = 0  // back-reference for the data rows below
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
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, d.pimoteUri)
                .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_OTHER)
                .withValue(ContactsContract.CommonDataKinds.Phone.LABEL, "Pimote")
                .build(),
        )
    }

    private fun updateRawContactOps(u: ContactsSync.UpdatePair): List<ContentProviderOperation> {
        val rawId = u.rawContactId
        val d = u.desired
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
                    arrayOf(rawId.toString(), ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE),
                )
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, d.pimoteUri)
                .build(),
        )
    }
}
