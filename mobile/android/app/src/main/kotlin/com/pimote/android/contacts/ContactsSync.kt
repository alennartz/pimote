package com.pimote.android.contacts

import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.telephony.PhoneAccountRules

/**
 * Pure-function contacts-sync logic. Computes the desired set of contact
 * entries from the current [SessionRepository] state and diffs them against
 * the existing entries to produce add/remove/update operations.
 *
 * The Android-specific layer (`ContactSyncRunner`) translates these
 * operations into `ContactsContract` `ContentProviderOperation` batches and
 * applies them to the system contacts database.
 */
object ContactsSync {

    /**
     * One contact entry as it should appear in the system contacts database.
     *
     * - [sourceId] is the stable cross-sync identifier stored in
     *   `RawContacts.SOURCE_ID`. Format: `"session:<id>"` or
     *   `"project:<base64url(folderPath)>"`. Same scheme as the Pimote URI we
     *   emit on the contact's phone-number row, so the system dialer's
     *   number-to-contact lookup works either direction.
     * - [displayName] is the user-visible label.
     * - [pimoteUri] is the dial URI — `pimote:session:<id>` or
     *   `pimote:project:<base64url(folderPath)>`. Stored as the contact's
     *   phone number; placing a call to that URI dispatches to the Pimote
     *   PhoneAccount via Telecom URI-scheme routing.
     * - [summary] is short text shown under the contact card's call action.
     */
    data class DesiredContact(
        val sourceId: String,
        val displayName: String,
        val pimoteUri: String,
        val summary: String,
    )

    /** A contact already present in ContactsContract under our Account. */
    data class ExistingContact(
        val sourceId: String,
        val rawContactId: Long,
        val displayName: String,
        val pimoteUri: String,
    )

    /** Diff result. Apply in order: deletions, then updates, then insertions. */
    data class SyncOps(
        val toInsert: List<DesiredContact>,
        val toDelete: List<Long>,                  // RawContacts._ID values
        val toUpdate: List<UpdatePair>,
    )

    /** Pair of (current rawContactId, new desired state) for label/URI changes. */
    data class UpdatePair(
        val rawContactId: Long,
        val desired: DesiredContact,
    )

    /**
     * Build the desired contact set from the repository state. Reuses
     * [PhoneAccountRules.sanitize] and [PhoneAccountRules.disambiguateFolderLabels]
     * for label rules — these stayed valid even after we abandoned the
     * per-session PhoneAccount model. There is no cap here: the system
     * contacts database imposes no limit comparable to Telecom's 10-account
     * cap.
     */
    fun computeDesiredContacts(
        projects: List<ProjectMeta>,
        sessions: List<SessionMeta>,
    ): List<DesiredContact> {
        val allPaths = (projects.map { it.folderPath } + sessions.map { it.folderPath }).distinct()
        val labels = PhoneAccountRules.disambiguateFolderLabels(allPaths)
        val out = ArrayList<DesiredContact>(projects.size + sessions.size)

        for (p in projects) {
            val prefix = PhoneAccountRules.sanitize(labels[p.folderPath] ?: p.folderName) ?: continue
            val sourceId = PhoneAccountRules.projectHandleId(p.folderPath)
            out.add(
                DesiredContact(
                    sourceId = sourceId,
                    displayName = prefix,
                    pimoteUri = "pimote:$sourceId",
                    summary = "New session in $prefix",
                ),
            )
        }
        for (s in sessions) {
            val prefix = PhoneAccountRules.sanitize(labels[s.folderPath] ?: s.folderName) ?: continue
            val nameRaw = s.name?.takeIf { it.isNotBlank() } ?: "untitled"
            val sessionPart = PhoneAccountRules.sanitize(nameRaw) ?: continue
            val combined = PhoneAccountRules.sanitize("$prefix/$sessionPart") ?: continue
            val sourceId = PhoneAccountRules.sessionHandleId(s.sessionId)
            out.add(
                DesiredContact(
                    sourceId = sourceId,
                    displayName = combined,
                    pimoteUri = "pimote:$sourceId",
                    summary = "Call $combined",
                ),
            )
        }
        return out
    }

    /**
     * Diff the desired set against the existing set. Stable on [sourceId]:
     *
     * - sourceId in desired but not existing → insert
     * - sourceId in existing but not desired → delete
     * - sourceId in both, but displayName or pimoteUri differs → update
     * - sourceId in both with identical fields → no-op
     */
    fun diff(
        desired: List<DesiredContact>,
        existing: List<ExistingContact>,
    ): SyncOps {
        val desiredBySource = desired.associateBy { it.sourceId }
        val existingBySource = existing.associateBy { it.sourceId }

        val toInsert = desired.filter { it.sourceId !in existingBySource }
        val toDelete = existing.filter { it.sourceId !in desiredBySource }.map { it.rawContactId }
        val toUpdate = desired.mapNotNull { d ->
            val e = existingBySource[d.sourceId] ?: return@mapNotNull null
            if (e.displayName == d.displayName && e.pimoteUri == d.pimoteUri) null
            else UpdatePair(rawContactId = e.rawContactId, desired = d)
        }

        return SyncOps(toInsert = toInsert, toDelete = toDelete, toUpdate = toUpdate)
    }
}
