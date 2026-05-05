package com.pimote.android.contacts

import android.accounts.Account
import android.content.AbstractThreadedSyncAdapter
import android.content.ContentProviderClient
import android.content.Context
import android.content.SyncResult
import android.os.Bundle

/**
 * No-op contacts SyncAdapter for the Pimote Account.
 *
 * Pimote does not drive contacts reconciliation through the platform
 * sync framework — [ContactSyncRunner] reacts to `SessionRepository`
 * directly. This shim exists purely so the Pimote `Account` is
 * recognized by Android as a first-class contacts-syncing account,
 * which gates contact visibility in some pickers (Auto / Assistant)
 * and surfaces the account under Settings → Accounts → Pimote → Contacts.
 *
 * Declared via a `<service>` with `android.content.SyncAdapter`
 * action and `@xml/syncadapter` meta-data in the manifest. See plan
 * `docs/plans/android-assistant-discoverable-contacts.md`.
 */
class PimoteSyncAdapter(
    context: Context,
    autoInitialize: Boolean,
) : AbstractThreadedSyncAdapter(context, autoInitialize) {

    override fun onPerformSync(
        account: Account,
        extras: Bundle,
        authority: String,
        provider: ContentProviderClient,
        syncResult: SyncResult,
    ) {
        // Intentionally empty. Reconciliation lives in ContactSyncRunner.
    }
}
