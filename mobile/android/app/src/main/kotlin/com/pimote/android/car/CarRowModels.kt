package com.pimote.android.car

import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.session.formatRelativeTime
import com.pimote.android.session.sessionDisplayName
import com.pimote.android.telephony.PhoneAccountRules

/**
 * One rendered list row for a car `ListTemplate`.
 *
 * Pure view-model — carries no Android framework types. Produced by the
 * [CarRowModels] helpers and consumed by the (framework-glue) car screens,
 * which turn each row into a tappable `Row` whose tap places
 * `CallByPimoteUri.placeCall(carContext, dialUri, telecomFacade)`.
 */
data class CarRow(
    /** Stable key: the source-id handle ("project:<b64>" or "session:<id>"). */
    val key: String,
    val title: String,
    val subtitle: String,
    /** Full dial URI to hand to CallByPimoteUri.placeCall, e.g. "pimote:project:<b64>". */
    val dialUri: String,
)

/**
 * Pure row-derivation helpers — the entire testable surface of the `car/`
 * module. Transform `(projects, sessions, now, limit)` into ordered,
 * truncated [CarRow] view-models, plus a degraded-state message helper.
 *
 * No Android framework types beyond the existing pure DTOs ([ProjectMeta],
 * [SessionMeta]) and the pure helpers they compose (`SessionDisplay`,
 * `PhoneAccountRules`).
 */
object CarRowModels {
    /**
     * Project-call rows for Screen 1. One row per project. Tapping places the
     * project hotline (new session) call.
     *
     * Ordering: by most-recent session activity (max `modified` over the
     * project's sessions) descending; projects with no sessions sort last,
     * ordered by the `<root> <basename>` title string.
     * Title: "<root> <basename>" via PhoneAccountRules.rootSegmentOf(folderPath)
     *   + folderName, falling back to the bare folderName when there is no root
     *   segment (mirrors ContactsSync).
     * Subtitle: session count + relative last-activity, e.g. "3 sessions · 5m ago";
     *   "No sessions yet" when the project has none.
     * dialUri: "pimote:" + PhoneAccountRules.projectHandleId(folderPath).
     * Truncation: at most [limit] rows after sorting.
     */
    fun projectCallRows(
        projects: List<ProjectMeta>,
        sessions: List<SessionMeta>,
        nowMillis: Long,
        limit: Int,
    ): List<CarRow> {
        val rows = projects.map { project ->
            val projectSessions = sessions.filter { it.folderPath == project.folderPath }
            val lastActivity = projectSessions.maxOfOrNull { it.modified }
            CarProjectRow(
                title = projectTitle(project.folderPath, project.folderName),
                lastActivity = lastActivity,
                row = CarRow(
                    key = PhoneAccountRules.projectHandleId(project.folderPath),
                    title = projectTitle(project.folderPath, project.folderName),
                    subtitle = projectSubtitle(projectSessions.size, lastActivity, nowMillis),
                    dialUri = "pimote:" + PhoneAccountRules.projectHandleId(project.folderPath),
                ),
            )
        }
        val withSessions = rows
            .filter { it.lastActivity != null }
            .sortedByDescending { it.lastActivity }
        val withoutSessions = rows
            .filter { it.lastActivity == null }
            .sortedBy { it.title }
        return (withSessions + withoutSessions).map { it.row }.take(limit)
    }

    private data class CarProjectRow(
        val title: String,
        val lastActivity: String?,
        val row: CarRow,
    )

    /** "<root> <basename>" via rootSegmentOf, bare basename when no root segment. */
    private fun projectTitle(folderPath: String, folderName: String): String {
        val root = PhoneAccountRules.rootSegmentOf(folderPath)
        return if (root != null) "$root $folderName" else folderName
    }

    private fun projectSubtitle(count: Int, lastActivity: String?, nowMillis: Long): String {
        if (count == 0 || lastActivity == null) return "No sessions yet"
        val noun = if (count == 1) "1 session" else "$count sessions"
        return "$noun · ${formatRelativeTime(lastActivity, nowMillis)}"
    }

    /**
     * Resume rows for Screen 2. Flat, NOT grouped by project.
     *
     * Ordering: by `modified` descending (most recent first).
     * Title: SessionDisplay.sessionDisplayName(session).
     * Subtitle: relative time (SessionDisplay.formatRelativeTime); must be non-empty.
     * dialUri: "pimote:" + PhoneAccountRules.sessionHandleId(sessionId).
     * Truncation: at most [limit] rows after sorting.
     */
    fun resumeSessionRows(
        sessions: List<SessionMeta>,
        nowMillis: Long,
        limit: Int,
    ): List<CarRow> =
        sessions
            .sortedByDescending { it.modified }
            .take(limit)
            .map { session ->
                CarRow(
                    key = PhoneAccountRules.sessionHandleId(session.sessionId),
                    title = sessionDisplayName(session),
                    subtitle = formatRelativeTime(session.modified, nowMillis),
                    dialUri = "pimote:" + PhoneAccountRules.sessionHandleId(session.sessionId),
                )
            }

    /**
     * Degraded-state message for an otherwise-empty list, or null when there is
     * content to show. Precedence: origin first (it gates everything), then
     * connection, then emptiness.
     *  - origin not configured → a message that names the real problem AND that
     *    it can't be fixed from the head unit (must be set on the phone).
     *  - origin set but not connected → connecting/offline message.
     *  - connected, no projects → "No projects yet".
     */
    fun carListMessage(
        originConfigured: Boolean,
        connected: Boolean,
        hasProjects: Boolean,
    ): String? = when {
        !originConfigured -> "Set the Pimote server address on your phone"
        !connected -> "Connecting to Pimote…"
        !hasProjects -> "No projects yet"
        else -> null
    }
}
