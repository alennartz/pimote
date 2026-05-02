package com.pimote.android.telephony

import com.pimote.android.util.L

/**
 * Registers a single "Pimote" PhoneAccount with Android Telecom — the
 * calling *service*, not a per-session contact. PhoneAccounts model
 * calling services (a SIM, a VoIP line); they're capped at 10 per app and
 * are not the right primitive for thousands of pimote sessions.
 *
 * Sessions and projects appear in the system contacts/dialer/Auto picker
 * via [com.pimote.android.contacts.ContactSyncRunner], which writes them
 * into ContactsContract under a "Pimote" Account. Each contact's phone
 * number is a `pimote:session:<id>` or `pimote:project:<base64url(path)>`
 * URI; Telecom routes those URIs to this PhoneAccount because we declare
 * `setSupportedUriSchemes(["pimote"])`.
 *
 * Outgoing-call dispatch lives in [PimoteConnectionService], which parses
 * the URI scheme on `ConnectionRequest.address` to determine the target.
 *
 * This replaces the prior architecture (one PhoneAccount per session/
 * project) — see DR-019 for the supersession.
 */
interface PhoneAccountRegistrar {
    /** Register the single Pimote service PhoneAccount. Idempotent. */
    fun start()

    /** Best-effort unregister and stop. */
    fun stop()
}

/** Stable handle id for the single Pimote service PhoneAccount. */
const val PIMOTE_SERVICE_HANDLE_ID: String = "pimote-service"

/** URI scheme this app handles in Telecom. */
const val PIMOTE_URI_SCHEME: String = "pimote"

/**
 * Pure-function helpers for the URI scheme used both by [com.pimote.android.contacts.ContactSyncRunner]
 * (writing contact phone numbers) and by [PimoteConnectionService] (parsing
 * the dialed URI on outgoing calls). Also retains the label sanitization /
 * folder-disambiguation rules used by the contacts sync.
 */
object PhoneAccountRules {

    /** Encode a folderPath into the `project:<base64>` source-id / handle id. */
    fun projectHandleId(folderPath: String): String {
        val enc = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(folderPath.toByteArray(Charsets.UTF_8))
        return "project:$enc"
    }

    /** Encode a sessionId into the `session:<id>` source-id / handle id. */
    fun sessionHandleId(sessionId: String): String = "session:$sessionId"

    /**
     * Decode a Pimote dial URI of the form `pimote:session:<id>` or
     * `pimote:project:<base64url(folderPath)>`. Returns null on
     * unparseable input.
     */
    fun parseDialUri(uri: String): ParsedDial? {
        val schemeStripped = when {
            uri.startsWith("$PIMOTE_URI_SCHEME:") -> uri.removePrefix("$PIMOTE_URI_SCHEME:")
            else -> return null
        }
        return when {
            schemeStripped.startsWith("session:") -> {
                val id = schemeStripped.removePrefix("session:")
                if (id.isBlank()) null else ParsedDial.Session(id)
            }
            schemeStripped.startsWith("project:") -> {
                val enc = schemeStripped.removePrefix("project:")
                val path = try {
                    String(java.util.Base64.getUrlDecoder().decode(enc), Charsets.UTF_8)
                } catch (_: Throwable) {
                    return null
                }
                if (path.isBlank()) null else ParsedDial.Project(path)
            }
            else -> null
        }
    }

    sealed interface ParsedDial {
        data class Session(val sessionId: String) : ParsedDial
        data class Project(val folderPath: String) : ParsedDial
    }

    /**
     * Apply the sanitization pipeline to [raw]. Returns null if the result is
     * empty (caller skips the entity).
     */
    fun sanitize(raw: String): String? {
        val replaced = buildString(raw.length) {
            for (c in raw) {
                if (c in '\u0000'..'\u001F') append(' ') else append(c)
            }
        }
        val collapsed = replaced.trim().replace(Regex("\\s+"), " ")
        if (collapsed.isEmpty()) return null
        val it = java.text.BreakIterator.getCharacterInstance()
        it.setText(collapsed)
        var count = 0
        var end = 0
        var next = it.next()
        while (next != java.text.BreakIterator.DONE) {
            count++
            end = next
            if (count >= 50) break
            next = it.next()
        }
        val truncated = if (count >= 50) collapsed.substring(0, end) else collapsed
        return truncated.ifEmpty { null }
    }

    /**
     * Derive unique short labels for the given set of folder paths. Returns a
     * map from folderPath → label. Non-colliding paths use just their
     * basename; colliding paths walk up segment-by-segment until labels are
     * globally unique within [folderPaths].
     */
    fun disambiguateFolderLabels(folderPaths: Collection<String>): Map<String, String> {
        val paths = folderPaths.distinct()
        val segments = paths.associateWith { p ->
            p.split('/').filter { it.isNotEmpty() }
        }
        val depth = paths.associateWith { 1 }.toMutableMap()
        fun labelFor(p: String): String {
            val segs = segments[p]!!
            val d = depth[p]!!.coerceAtMost(segs.size).coerceAtLeast(1)
            return segs.takeLast(d).joinToString("/")
        }
        repeat(64) {
            val labels = paths.associateWith { labelFor(it) }
            val byLabel = labels.entries.groupBy({ it.value }, { it.key })
            val collisions = byLabel.filterValues { it.size > 1 }
            if (collisions.isEmpty()) return labels
            for ((_, colliders) in collisions) {
                for (p in colliders) {
                    val segs = segments[p]!!
                    if (depth[p]!! < segs.size) depth[p] = depth[p]!! + 1
                }
            }
        }
        return paths.associateWith { labelFor(it) }
    }
}

/**
 * Production [PhoneAccountRegistrar]. Registers exactly one Pimote service
 * PhoneAccount via [TelecomFacade] and otherwise does nothing. Idempotent.
 */
class PhoneAccountRegistrarImpl(
    private val telecom: TelecomFacade,
) : PhoneAccountRegistrar {

    override fun start() {
        val acct = TelecomFacade.Account(
            handleId = PIMOTE_SERVICE_HANDLE_ID,
            label = "Pimote",
            shortDescription = "Pimote calling service",
        )
        try {
            telecom.registerPhoneAccount(acct)
            L.i("Tel", "registered Pimote service PhoneAccount")
        } catch (t: Throwable) {
            L.w("Tel", "failed to register Pimote service PhoneAccount: ${t.message}", t)
        }
    }

    override fun stop() {
        try { telecom.unregisterPhoneAccount(PIMOTE_SERVICE_HANDLE_ID) } catch (_: Throwable) { }
    }
}
