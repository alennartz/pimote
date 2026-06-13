package com.pimote.android.car

import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta

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
     * ordered by title.
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
    ): List<CarRow> = TODO("not implemented")

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
    ): List<CarRow> = TODO("not implemented")

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
    ): String? = TODO("not implemented")
}
