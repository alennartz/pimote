package com.pimote.android.contacts

/**
 * Pure declaration of the Pimote callable contact-row contract — the
 * custom MIME type and the column-by-column shape of the data row that
 * carries a `pimote:` dial URI under each Pimote-synced contact.
 *
 * This is the row representation announced to the platform via the
 * `CONTACTS_STRUCTURE` resource on the AccountAuthenticator service,
 * and the row that [ContactSyncRunner] writes to / reads from
 * `ContactsContract.Data`. Keeping the mapping pure here lets it be
 * unit-tested in isolation from the ContentResolver glue.
 *
 * Replaces (in part) DR-019's choice to store the dial URI in
 * `CommonDataKinds.Phone.NUMBER`, which Google Assistant / Gemini do
 * not recognize as a callable affordance for non-`tel:` URIs.
 */
object PimoteContactsContract {

    /**
     * Custom callable MIME type. Distinct, package-namespaced cursor
     * item type. Mirrored verbatim in `res/xml/contacts.xml` and
     * referenced from `ContactSyncRunner` when inserting / updating
     * the callable row.
     */
    const val MIME_CALLABLE: String = "vnd.android.cursor.item/vnd.com.pimote.android.call"

    /** Short label rendered under the icon on the contact card row. */
    const val LABEL: String = "Pimote"

    /**
     * Column values for the callable data row of a Pimote contact.
     *
     * - [mimeType] always [MIME_CALLABLE].
     * - [data1] the dial URI (`pimote:session:<id>` /
     *   `pimote:project:<base64url(path)>`). The `actionInflate` /
     *   intent declared in `res/xml/contacts.xml` binds against
     *   `data1` so tap / Assistant resolve to a `placeCall(data1)`
     *   on our self-managed PhoneAccount via URI-scheme routing.
     * - [data2] short label shown under the row icon. Always
     *   [LABEL].
     * - [data3] the human-readable summary line shown under the
     *   action ("Call repo/feature", etc.).
     * - [isPrimary] always 1 — there is exactly one callable row per
     *   Pimote contact and it must be the default action.
     */
    data class CallableRow(
        val mimeType: String,
        val data1: String,
        val data2: String,
        val data3: String,
        val isPrimary: Int,
    )

    /**
     * Pure mapping from a desired contact to the column values of its
     * callable data row.
     */
    fun callableRowFor(desired: ContactsSync.DesiredContact): CallableRow =
        CallableRow(
            mimeType = MIME_CALLABLE,
            data1 = desired.pimoteUri,
            data2 = LABEL,
            data3 = desired.summary,
            isPrimary = 1,
        )
}
