package com.pimote.android.telephony

/**
 * The concrete entity behind a Telecom `PhoneAccountHandle.id` — either an
 * existing pimote session or a project hotline (calling it creates a new
 * session in the folder). [PhoneAccountRegistrar.resolve] returns one of
 * these for a handle id pulled off an outgoing-call request.
 */
sealed interface AccountKind {
    data class Session(
        val sessionId: String,
        val folderName: String,
        val sessionName: String,
    ) : AccountKind

    data class Project(
        val folderPath: String,
        val folderName: String,
    ) : AccountKind
}

/**
 * Reconciles the live session/project list from [com.pimote.android.session.SessionRepository]
 * into Android Telecom as `PhoneAccount`s.
 *
 * `PhoneAccountHandle.id` scheme:
 * - Session: `"session:<sessionId>"`
 * - Project: `"project:<base64url(folderPath)>"`  (RFC 4648 §5, no padding)
 *
 * Display-name rules:
 * - Session label: `"<folderName>/<sessionName>"`.
 * - Project label: `"<folderName>"`.
 * - Short description: `"Pimote: <displayName>"`.
 *
 * Sanitization (in order, applied to label and `folderName`/`sessionName` inputs):
 * 1. Trim leading/trailing whitespace.
 * 2. Replace ASCII control chars (`\u0000`–`\u001F`) with a single space.
 * 3. Collapse runs of whitespace to one space.
 * 4. Truncate to 50 graphemes (not codepoints).
 * 5. If empty after sanitization → skip registration entirely.
 *
 * Folder-name disambiguation: when two or more folder paths share the same
 * basename, walk up one segment at a time on each colliding folder until the
 * resulting labels are unique. Sessions inside disambiguated projects pick up
 * the same prefix. Non-collided projects keep the basename only.
 *
 * Reconciliation: combined upstream of [SessionRepository.projects] and
 * `.sessions` is debounced 500 ms before each diff. Diff against the current
 * registered set — additions register, removals unregister, label changes
 * unregister + reregister. A `Map<String, AccountKind>` keyed by `handleId`
 * backs [resolve].
 */
interface PhoneAccountRegistrar {
    /** Begin observing the repository and reconciling. Idempotent. */
    fun start()

    /** Best-effort unregister-everything + stop observing. */
    fun stop()

    /**
     * Look up the entity for a `PhoneAccountHandle.id`. Returns null if the
     * id isn't in the current registered set.
     */
    fun resolve(handleId: String): AccountKind?
}

/**
 * Pure-function utilities for the registrar. Extracted so the reconciliation
 * rules can be unit-tested without spinning up the system Telecom stack.
 */
object PhoneAccountRules {
    /**
     * Apply the sanitization pipeline to [raw]. Returns null if the result is
     * empty (caller skips the entity).
     */
    fun sanitize(raw: String): String? {
        // 1. trim, 2. replace ASCII control chars with space, 3. collapse whitespace runs
        val replaced = buildString(raw.length) {
            for (c in raw) {
                if (c in '\u0000'..'\u001F') append(' ') else append(c)
            }
        }
        val collapsed = replaced.trim().replace(Regex("\\s+"), " ")
        if (collapsed.isEmpty()) return null
        // 4. truncate to 50 graphemes
        val it = java.text.BreakIterator.getCharacterInstance()
        it.setText(collapsed)
        var count = 0
        var end = 0
        var cur = it.first()
        var next = it.next()
        while (next != java.text.BreakIterator.DONE) {
            count++
            end = next
            if (count >= 50) break
            cur = next
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
     *
     * Example: `["/work/repo", "/personal/repo", "/lone"]` →
     * `{"/work/repo": "work/repo", "/personal/repo": "personal/repo", "/lone": "lone"}`.
     */
    fun disambiguateFolderLabels(folderPaths: Collection<String>): Map<String, String> {
        // Split each path into segments; start with depth=1 (basename) per path.
        // Increase depth only for paths whose current label collides with another path.
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
        // Iterate until stable.
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

    /**
     * Compute the desired Telecom account set from the inputs. Pure function:
     * applies sanitization + disambiguation + handle-id encoding and returns
     * accounts keyed by `handleId`. Inputs that sanitize to empty are
     * silently dropped.
     */
    fun computeDesiredAccounts(
        projects: List<ProjectInput>,
        sessions: List<SessionInput>,
    ): Map<String, DesiredAccount> {
        // Disambiguate label prefixes across the union of folder paths in projects + sessions.
        val allPaths = (projects.map { it.folderPath } + sessions.map { it.folderPath }).distinct()
        val labels = disambiguateFolderLabels(allPaths)
        val out = LinkedHashMap<String, DesiredAccount>()
        for (p in projects) {
            val prefix = sanitize(labels[p.folderPath] ?: p.folderName) ?: continue
            val handleId = projectHandleId(p.folderPath)
            out[handleId] = DesiredAccount(
                handleId = handleId,
                kind = AccountKind.Project(p.folderPath, prefix),
                label = prefix,
                shortDescription = "Pimote: $prefix",
            )
        }
        for (s in sessions) {
            val prefix = sanitize(labels[s.folderPath] ?: s.folderName) ?: continue
            val nameRaw = s.sessionName ?: "untitled"
            val sessionPart = sanitize(nameRaw) ?: sanitize("untitled") ?: continue
            val combined = sanitize("$prefix/$sessionPart") ?: continue
            val handleId = sessionHandleId(s.sessionId)
            out[handleId] = DesiredAccount(
                handleId = handleId,
                kind = AccountKind.Session(s.sessionId, prefix, sessionPart),
                label = combined,
                shortDescription = "Pimote: $combined",
            )
        }
        return out
    }

    /** Diff [current] (handleId → label) against [desired]; emits add/remove/replace ops. */
    fun diff(
        current: Map<String, String>,
        desired: Map<String, String>,
    ): ReconcileOps {
        val toRegister = desired.keys.filter { it !in current }
        val toUnregister = current.keys.filter { it !in desired }
        val toReplace = desired.keys.filter { it in current && current[it] != desired[it] }
        return ReconcileOps(toRegister, toUnregister, toReplace)
    }

    data class ProjectInput(val folderPath: String, val folderName: String)
    data class SessionInput(
        val sessionId: String,
        val folderPath: String,
        val folderName: String,
        val sessionName: String?,
    )

    data class DesiredAccount(
        val handleId: String,
        val kind: AccountKind,
        val label: String,
        val shortDescription: String,
    )

    /** Atomic reconciliation operations, applied in order: removes → adds. */
    data class ReconcileOps(
        val toRegister: List<String>,
        val toUnregister: List<String>,
        val toReplace: List<String>, // unregister + register (label change)
    )

    /** Encode a folderPath into the `project:<base64url>` handleId. */
    fun projectHandleId(folderPath: String): String {
        val enc = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(folderPath.toByteArray(Charsets.UTF_8))
        return "project:$enc"
    }

    /** Encode a sessionId into the `session:<id>` handleId. */
    fun sessionHandleId(sessionId: String): String = "session:$sessionId"
}

/**
 * Production [PhoneAccountRegistrar]. Subscribes to the repository's projects
 * and sessions, debounces the combined upstream by [debounceMs] (500 ms in
 * production) before each reconciliation pass, and applies the resulting
 * diff via [TelecomFacade]. Maintains a `Map<handleId, AccountKind>` to back
 * [resolve]. Tests construct it with a fake repository, fake facade, and a
 * controlled scheduler.
 */
class PhoneAccountRegistrarImpl(
    private val repository: com.pimote.android.session.SessionRepository,
    private val telecom: TelecomFacade,
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val debounceMs: Long = 500L,
) : PhoneAccountRegistrar {
    override fun start(): Unit = TODO("not implemented")
    override fun stop(): Unit = TODO("not implemented")
    override fun resolve(handleId: String): AccountKind? = TODO("not implemented")
}
