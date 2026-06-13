package com.pimote.android.car

import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.session.formatRelativeTime
import com.pimote.android.session.sessionDisplayName
import com.pimote.android.telephony.PhoneAccountRules
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for [CarRowModels] — the testable seam of the Android Auto
 * car surface. Exercises row ordering, subtitle/dialUri derivation,
 * truncation, and the degraded-state message precedence. The
 * CarAppService/Screen framework glue is intentionally NOT tested here.
 */
class CarRowModelsTest {

    private fun project(path: String, name: String = path.trimStart('/')) =
        ProjectMeta(folderPath = path, folderName = name)

    private fun session(
        id: String,
        folderPath: String,
        modified: String,
        created: String = modified,
        name: String? = null,
        firstMessage: String? = null,
        cwd: String? = null,
    ) = SessionMeta(
        sessionId = id,
        folderPath = folderPath,
        folderName = folderPath.trimStart('/'),
        name = name,
        archived = false,
        modified = modified,
        created = created,
        messageCount = 1,
        firstMessage = firstMessage,
        cwd = cwd,
    )

    // arbitrary fixed "now" well after the test timestamps below
    private val now = java.time.Instant.parse("2026-04-10T00:00:00.000Z").toEpochMilli()

    private fun projectDialUri(folderPath: String) =
        "pimote:" + PhoneAccountRules.projectHandleId(folderPath)

    private fun sessionDialUri(sessionId: String) =
        "pimote:" + PhoneAccountRules.sessionHandleId(sessionId)

    // ======================================================= projectCallRows

    @Test
    fun `projectCallRows emits one row per project`() {
        val rows = CarRowModels.projectCallRows(
            projects = listOf(project("/a"), project("/b"), project("/c")),
            sessions = listOf(session("a1", "/a", "2026-04-05T10:00:00.000Z")),
            nowMillis = now,
            limit = 10,
        )
        assertEquals(3, rows.size)
    }

    @Test
    fun `projectCallRows orders by most-recent session activity descending`() {
        val rows = CarRowModels.projectCallRows(
            projects = listOf(project("/a", "alpha"), project("/b", "beta"), project("/c", "charlie")),
            sessions = listOf(
                session("a1", "/a", "2026-04-01T10:00:00.000Z"),
                session("b1", "/b", "2026-04-06T08:00:00.000Z"),
                session("c1", "/c", "2026-04-03T09:00:00.000Z"),
            ),
            nowMillis = now,
            limit = 10,
        )
        assertEquals(
            listOf(projectDialUri("/b"), projectDialUri("/c"), projectDialUri("/a")),
            rows.map { it.dialUri },
        )
    }

    @Test
    fun `projectCallRows sorts no-session projects last ordered by title`() {
        val rows = CarRowModels.projectCallRows(
            projects = listOf(project("/z", "zeta"), project("/a", "alpha"), project("/b", "beta")),
            sessions = listOf(session("b1", "/b", "2026-04-05T10:00:00.000Z")),
            nowMillis = now,
            limit = 10,
        )
        // beta has the only session → first. alpha & zeta empty → alphabetical by title.
        assertEquals(
            listOf("beta", "alpha", "zeta"),
            rows.map { it.title },
        )
    }

    @Test
    fun `projectCallRows builds the project dial URI`() {
        val rows = CarRowModels.projectCallRows(
            projects = listOf(project("/work/repo")),
            sessions = emptyList(),
            nowMillis = now,
            limit = 10,
        )
        assertEquals(projectDialUri("/work/repo"), rows.single().dialUri)
        assertTrue(rows.single().dialUri.startsWith("pimote:project:"))
    }

    @Test
    fun `projectCallRows uses the project handle as the stable key`() {
        val rows = CarRowModels.projectCallRows(
            projects = listOf(project("/work/repo")),
            sessions = emptyList(),
            nowMillis = now,
            limit = 10,
        )
        assertEquals(PhoneAccountRules.projectHandleId("/work/repo"), rows.single().key)
    }

    @Test
    fun `projectCallRows subtitle pluralizes session count and shows relative activity`() {
        val rows = CarRowModels.projectCallRows(
            projects = listOf(project("/a")),
            sessions = listOf(
                session("a1", "/a", "2026-04-09T23:55:00.000Z"),
                session("a2", "/a", "2026-04-09T23:50:00.000Z"),
                session("a3", "/a", "2026-04-09T23:45:00.000Z"),
            ),
            nowMillis = now,
            limit = 10,
        )
        val subtitle = rows.single().subtitle
        assertTrue(subtitle.contains("3 sessions"), "expected plural count, got: $subtitle")
        // last activity = newest session (5m before now)
        assertTrue(subtitle.contains("5m ago"), "expected relative activity, got: $subtitle")
    }

    @Test
    fun `projectCallRows subtitle uses singular for one session`() {
        val rows = CarRowModels.projectCallRows(
            projects = listOf(project("/a")),
            sessions = listOf(session("a1", "/a", "2026-04-09T23:55:00.000Z")),
            nowMillis = now,
            limit = 10,
        )
        val subtitle = rows.single().subtitle
        assertTrue(subtitle.contains("1 session"), "expected singular, got: $subtitle")
        assertFalse(subtitle.contains("1 sessions"), "should not pluralize one, got: $subtitle")
    }

    @Test
    fun `projectCallRows subtitle reads 'No sessions yet' for empty projects`() {
        val rows = CarRowModels.projectCallRows(
            projects = listOf(project("/a")),
            sessions = emptyList(),
            nowMillis = now,
            limit = 10,
        )
        assertEquals("No sessions yet", rows.single().subtitle)
    }

    @Test
    fun `projectCallRows titles are stable and non-empty`() {
        val rows = CarRowModels.projectCallRows(
            projects = listOf(project("/work/repo", "repo")),
            sessions = emptyList(),
            nowMillis = now,
            limit = 10,
        )
        assertTrue(rows.single().title.isNotBlank())
    }

    @Test
    fun `projectCallRows truncates to limit after sorting by recency`() {
        val rows = CarRowModels.projectCallRows(
            projects = listOf(
                project("/a", "alpha"),
                project("/b", "beta"),
                project("/c", "charlie"),
                project("/d", "delta"),
                project("/e", "echo"),
            ),
            sessions = listOf(
                session("a1", "/a", "2026-04-01T10:00:00.000Z"),
                session("b1", "/b", "2026-04-05T10:00:00.000Z"),
                session("c1", "/c", "2026-04-03T10:00:00.000Z"),
                session("d1", "/d", "2026-04-04T10:00:00.000Z"),
                session("e1", "/e", "2026-04-02T10:00:00.000Z"),
            ),
            nowMillis = now,
            limit = 2,
        )
        // newest two by activity: beta (04-05), delta (04-04)
        assertEquals(2, rows.size)
        assertEquals(listOf("beta", "delta"), rows.map { it.title })
    }

    @Test
    fun `projectCallRows returns empty for no projects`() {
        assertEquals(
            emptyList<CarRow>(),
            CarRowModels.projectCallRows(emptyList(), emptyList(), now, 10),
        )
    }

    // ===================================================== resumeSessionRows

    @Test
    fun `resumeSessionRows orders flat by modified descending across projects`() {
        val rows = CarRowModels.resumeSessionRows(
            sessions = listOf(
                session("a1", "/a", "2026-04-01T10:00:00.000Z"),
                session("b1", "/b", "2026-04-06T08:00:00.000Z"),
                session("a2", "/a", "2026-04-04T09:00:00.000Z"),
            ),
            nowMillis = now,
            limit = 10,
        )
        // a session in project B newer than ones in project A sorts first.
        assertEquals(listOf("b1", "a2", "a1"), rows.map { it.key.removePrefix("session:") })
    }

    @Test
    fun `resumeSessionRows builds the session dial URI`() {
        val rows = CarRowModels.resumeSessionRows(
            sessions = listOf(session("sess-123", "/a", "2026-04-05T10:00:00.000Z")),
            nowMillis = now,
            limit = 10,
        )
        assertEquals(sessionDialUri("sess-123"), rows.single().dialUri)
        assertTrue(rows.single().dialUri.startsWith("pimote:session:"))
    }

    @Test
    fun `resumeSessionRows uses the session handle as the stable key`() {
        val rows = CarRowModels.resumeSessionRows(
            sessions = listOf(session("sess-123", "/a", "2026-04-05T10:00:00.000Z")),
            nowMillis = now,
            limit = 10,
        )
        assertEquals(PhoneAccountRules.sessionHandleId("sess-123"), rows.single().key)
    }

    @Test
    fun `resumeSessionRows title uses the session display name`() {
        val s = session("sess-123", "/a", "2026-04-05T10:00:00.000Z", name = "feature-x")
        val rows = CarRowModels.resumeSessionRows(listOf(s), now, 10)
        assertEquals(sessionDisplayName(s), rows.single().title)
        assertEquals("feature-x", rows.single().title)
    }

    @Test
    fun `resumeSessionRows subtitle is non-empty relative time`() {
        val rows = CarRowModels.resumeSessionRows(
            sessions = listOf(session("a1", "/a", "2026-04-09T23:55:00.000Z")),
            nowMillis = now,
            limit = 10,
        )
        assertTrue(rows.single().subtitle.isNotBlank())
        assertTrue(
            rows.single().subtitle.contains(formatRelativeTime("2026-04-09T23:55:00.000Z", now)),
        )
    }

    @Test
    fun `resumeSessionRows truncates to limit after sorting`() {
        val rows = CarRowModels.resumeSessionRows(
            sessions = listOf(
                session("a1", "/a", "2026-04-01T10:00:00.000Z"),
                session("b1", "/b", "2026-04-06T08:00:00.000Z"),
                session("c1", "/c", "2026-04-03T10:00:00.000Z"),
            ),
            nowMillis = now,
            limit = 2,
        )
        assertEquals(2, rows.size)
        assertEquals(listOf("b1", "c1"), rows.map { it.key.removePrefix("session:") })
    }

    @Test
    fun `resumeSessionRows returns empty for no sessions`() {
        assertEquals(
            emptyList<CarRow>(),
            CarRowModels.resumeSessionRows(emptyList(), now, 10),
        )
    }

    // ======================================================== carListMessage

    @Test
    fun `carListMessage prioritizes origin-not-configured over connection and content`() {
        // origin gates everything: returned regardless of connected/hasProjects
        val a = CarRowModels.carListMessage(originConfigured = false, connected = false, hasProjects = false)
        val b = CarRowModels.carListMessage(originConfigured = false, connected = true, hasProjects = true)
        assertEquals(a, b)
        assertTrue(a != null && a.isNotBlank())
    }

    @Test
    fun `carListMessage origin message points at the phone not a transient state`() {
        val msg = CarRowModels.carListMessage(originConfigured = false, connected = false, hasProjects = false)!!
        val lower = msg.lowercase()
        // must read as a phone-side fix, not "Connecting…"
        assertTrue(lower.contains("phone"), "expected a phone-side directive, got: $msg")
        assertFalse(lower.contains("connecting"), "must not look like a transient connection state: $msg")
    }

    @Test
    fun `carListMessage returns the disconnected message when configured but not connected`() {
        val msg = CarRowModels.carListMessage(originConfigured = true, connected = false, hasProjects = false)
        assertTrue(msg != null && msg.isNotBlank())
        // independent of projects when disconnected
        assertEquals(
            msg,
            CarRowModels.carListMessage(originConfigured = true, connected = false, hasProjects = true),
        )
    }

    @Test
    fun `carListMessage reads 'No projects yet' when connected with no projects`() {
        assertEquals(
            "No projects yet",
            CarRowModels.carListMessage(originConfigured = true, connected = true, hasProjects = false),
        )
    }

    @Test
    fun `carListMessage returns null when there is content to show`() {
        assertNull(CarRowModels.carListMessage(originConfigured = true, connected = true, hasProjects = true))
    }
}
