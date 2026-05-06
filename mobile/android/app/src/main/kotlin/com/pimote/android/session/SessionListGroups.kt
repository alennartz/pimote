package com.pimote.android.session

import java.time.Instant

/**
 * Pure helper that groups sessions under their parent project, sorts
 * sessions by recency within each group, and sorts the groups by their
 * most-recent session.
 *
 * Mirrors `client/src/lib/session-list-groups.ts` so the Android in-app
 * contacts screen has the same layout rhythm as the PWA session list.
 */
data class SessionProjectGroup(
    val project: ProjectMeta,
    val sessions: List<SessionMeta>,
    /** ISO-8601 UTC of the group's first session after recency sorting. */
    val lastModified: String,
)

/**
 * Build the list of project groups for display.
 *
 * - Empty projects ARE kept (unlike the PWA, which drops them). On mobile,
 *   the project header is the call-into-a-new-session affordance, so empty
 *   projects must remain visible.
 * - Sessions sort newest-first by `modified`, breaking ties on `created`
 *   then `sessionId` ascending.
 * - Groups sort newest-first by `lastModified`, breaking ties on
 *   `project.folderName` ascending. Empty groups have no `lastModified`;
 *   they sort to the bottom (epoch 0) and break ties alphabetically.
 */
fun buildSessionProjectGroups(
    projects: List<ProjectMeta>,
    sessions: List<SessionMeta>,
): List<SessionProjectGroup> {
    val byPath: Map<String, List<SessionMeta>> = sessions.groupBy { it.folderPath }
    val sessionComparator: Comparator<SessionMeta> =
        compareByDescending<SessionMeta> { parseTimestamp(it.modified) }
            .thenByDescending { parseTimestamp(it.created) }
            .thenBy { it.sessionId }

    val groups = projects.map { p ->
        val folderSessions = byPath[p.folderPath].orEmpty()
        val sorted = folderSessions.sortedWith(sessionComparator)
        SessionProjectGroup(
            project = p,
            sessions = sorted,
            // Empty groups: empty string sorts as epoch 0 via parseTimestamp,
            // pushing them below any group with real sessions.
            lastModified = sorted.firstOrNull()?.modified ?: "",
        )
    }

    val groupComparator: Comparator<SessionProjectGroup> =
        compareByDescending<SessionProjectGroup> { parseTimestamp(it.lastModified) }
            .thenBy { it.project.folderName }

    return groups.sortedWith(groupComparator)
}

private fun parseTimestamp(s: String): Long = try {
    Instant.parse(s).toEpochMilli()
} catch (_: Throwable) {
    0L
}
