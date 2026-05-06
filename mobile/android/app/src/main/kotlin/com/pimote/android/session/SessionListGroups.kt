package com.pimote.android.session

/**
 * Pure helper that groups sessions under their parent project, sorts
 * sessions by recency within each group, and sorts the groups by their
 * most-recent session.
 *
 * Mirrors `client/src/lib/session-list-groups.ts` so the Android in-app
 * contacts screen has the same layout rhythm as the PWA session list.
 *
 * Implementation pending \u2014 see plan
 * `docs/plans/android-contacts-screen-pwa-parity.md`.
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
 * - Folders with no sessions are dropped.
 * - Sessions sort newest-first by `modified`, breaking ties on `created`
 *   then `sessionId` ascending.
 * - Groups sort newest-first by `lastModified`, breaking ties on
 *   `project.folderName` ascending.
 */
fun buildSessionProjectGroups(
    projects: List<ProjectMeta>,
    sessions: List<SessionMeta>,
): List<SessionProjectGroup> = TODO("Implemented in implementing phase")
