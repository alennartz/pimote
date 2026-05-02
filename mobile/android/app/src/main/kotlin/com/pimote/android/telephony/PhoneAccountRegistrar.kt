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
        // Use java.net.URI to obtain the *decoded* scheme-specific-part. Telecom
        // round-trips outgoing-call URIs through android.net.Uri, which percent-
        // encodes ':' in the SSP (so what we constructed as `pimote:session:<id>`
        // arrives at ConnectionService as `pimote:session%3A<id>`). The literal
        // string check we used previously was fooled by that encoding.
        val parsed = try { java.net.URI(uri) } catch (_: Throwable) { return null }
        if (parsed.scheme != PIMOTE_URI_SCHEME) return null
        val ssp = parsed.schemeSpecificPart ?: return null
        return when {
            ssp.startsWith("session:") -> {
                val id = ssp.removePrefix("session:")
                if (id.isBlank()) null else ParsedDial.Session(id)
            }
            ssp.startsWith("project:") -> {
                val enc = ssp.removePrefix("project:")
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
        // Telecom retains PhoneAccount registrations across app launches and even
        // across upgrade-installs. Earlier versions of this app registered up to
        // 10 accounts (one per session/project) under DR-018. Those ghosts persist
        // in Telecom's database and consume the per-package 10-account cap, so
        // attempting to register the new single "pimote-service" account fails
        // with IllegalArgumentException("limit, 10, has been reached") until they
        // are explicitly removed. Sweep them on every start.
        val existing = try { telecom.registeredAccounts() } catch (t: Throwable) {
            L.w("Tel", "registeredAccounts() failed; skipping ghost cleanup: ${t.message}", t)
            emptyMap()
        }
        for (handleId in existing.keys) {
            if (handleId == PIMOTE_SERVICE_HANDLE_ID) continue
            try {
                telecom.unregisterPhoneAccount(handleId)
                L.i("Tel", "unregistered ghost PhoneAccount handleId=$handleId")
            } catch (t: Throwable) {
                L.w("Tel", "failed to unregister ghost handleId=$handleId: ${t.message}", t)
            }
        }

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
