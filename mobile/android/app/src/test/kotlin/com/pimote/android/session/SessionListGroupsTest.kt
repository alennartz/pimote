package com.pimote.android.session

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for [buildSessionProjectGroups]. Mirrors
 * `client/src/lib/session-list-groups.test.ts` so the Android in-app
 * contacts screen and the PWA session list share grouping/recency
 * semantics.
 */
class SessionListGroupsTest {

    private fun project(path: String, name: String) = ProjectMeta(folderPath = path, folderName = name)

    private fun session(
        id: String,
        folderPath: String,
        modified: String,
        created: String = modified,
    ) = SessionMeta(
        sessionId = id,
        folderPath = folderPath,
        folderName = folderPath.trimStart('/'),
        name = null,
        archived = false,
        modified = modified,
        created = created,
        messageCount = 1,
        firstMessage = null,
        cwd = null,
    )

    @Test
    fun `keeps empty projects and sorts them after non-empty ones`() {
        // On mobile, the project header is the call-into-a-new-session
        // affordance, so empty projects must remain visible. They sort
        // below any project with sessions (epoch-0 lastModified) and
        // alphabetically among themselves.
        val groups = buildSessionProjectGroups(
            projects = listOf(project("/a", "alpha"), project("/b", "beta"), project("/c", "charlie")),
            sessions = listOf(session("b1", "/b", "2026-04-05T10:00:00.000Z")),
        )
        // beta has the only session → first. alpha and charlie are empty → alphabetical.
        assertEquals(listOf("beta", "alpha", "charlie"), groups.map { it.project.folderName })
        assertEquals(emptyList<String>(), groups[1].sessions.map { it.sessionId })
        assertEquals(emptyList<String>(), groups[2].sessions.map { it.sessionId })
    }

    @Test
    fun `sorts sessions newest-first within each project`() {
        val groups = buildSessionProjectGroups(
            projects = listOf(project("/a", "alpha")),
            sessions = listOf(
                session("older",  "/a", "2026-04-01T10:00:00.000Z"),
                session("newer",  "/a", "2026-04-05T12:00:00.000Z"),
                session("middle", "/a", "2026-04-03T09:00:00.000Z"),
            ),
        )
        assertEquals(listOf("newer", "middle", "older"), groups.single().sessions.map { it.sessionId })
        assertEquals("2026-04-05T12:00:00.000Z", groups.single().lastModified)
    }

    @Test
    fun `sorts project groups by their most recently active session`() {
        val groups = buildSessionProjectGroups(
            projects = listOf(project("/a", "alpha"), project("/b", "beta"), project("/c", "charlie")),
            sessions = listOf(
                session("a1", "/a", "2026-04-01T10:00:00.000Z"),
                session("b1", "/b", "2026-04-06T08:00:00.000Z"),
                session("c1", "/c", "2026-04-03T09:00:00.000Z"),
            ),
        )
        assertEquals(listOf("beta", "charlie", "alpha"), groups.map { it.project.folderName })
    }

    @Test
    fun `recency tie-breakers fall through to created then sessionId`() {
        val groups = buildSessionProjectGroups(
            projects = listOf(project("/a", "alpha")),
            sessions = listOf(
                session("z", "/a", "2026-04-05T10:00:00.000Z", created = "2026-04-01T00:00:00.000Z"),
                session("a", "/a", "2026-04-05T10:00:00.000Z", created = "2026-04-05T00:00:00.000Z"),
                session("m", "/a", "2026-04-05T10:00:00.000Z", created = "2026-04-05T00:00:00.000Z"),
            ),
        )
        // Same `modified` → sort by `created` desc → 'a' and 'm' come before 'z'.
        // Same `created` between 'a' and 'm' → sessionId asc → 'a' before 'm'.
        assertEquals(listOf("a", "m", "z"), groups.single().sessions.map { it.sessionId })
    }

    @Test
    fun `unparseable timestamps sort to the bottom`() {
        val groups = buildSessionProjectGroups(
            projects = listOf(project("/a", "alpha")),
            sessions = listOf(
                session("garbage", "/a", "not a real timestamp"),
                session("real",    "/a", "2026-04-05T10:00:00.000Z"),
            ),
        )
        assertEquals(listOf("real", "garbage"), groups.single().sessions.map { it.sessionId })
    }

    @Test
    fun `no projects yields empty groups`() {
        assertEquals(emptyList<SessionProjectGroup>(), buildSessionProjectGroups(emptyList(), emptyList()))
    }

    @Test
    fun `projects with no sessions still produce groups (mobile divergence from PWA)`() {
        val groups = buildSessionProjectGroups(
            projects = listOf(project("/a", "alpha")),
            sessions = emptyList(),
        )
        assertEquals(1, groups.size)
        assertEquals("alpha", groups.single().project.folderName)
        assertEquals(emptyList<String>(), groups.single().sessions.map { it.sessionId })
    }

    @Test
    fun `sessions whose folderPath has no matching project are dropped`() {
        // No project for /b → its sessions don't surface even though they exist
        // in the snapshot. Matches PWA behavior where the folder list is the
        // authoritative grouping driver.
        val groups = buildSessionProjectGroups(
            projects = listOf(project("/a", "alpha")),
            sessions = listOf(
                session("a1", "/a", "2026-04-01T10:00:00.000Z"),
                session("b1", "/b", "2026-04-06T08:00:00.000Z"),
            ),
        )
        assertEquals(listOf("alpha"), groups.map { it.project.folderName })
        assertEquals(listOf("a1"), groups.single().sessions.map { it.sessionId })
    }

    @Test
    fun `group lastModified equals the first session's modified after sorting`() {
        val groups = buildSessionProjectGroups(
            projects = listOf(project("/a", "alpha")),
            sessions = listOf(
                session("older", "/a", "2026-04-01T10:00:00.000Z"),
                session("newer", "/a", "2026-04-05T12:00:00.000Z"),
            ),
        )
        assertEquals("2026-04-05T12:00:00.000Z", groups.single().lastModified)
    }
}
