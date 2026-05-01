package com.pimote.android.session

import com.pimote.android.protocol.FolderInfo
import com.pimote.android.protocol.SessionArchivedEvent
import com.pimote.android.protocol.SessionDeletedEvent
import com.pimote.android.protocol.SessionOpenedEvent
import com.pimote.android.protocol.SessionRenamedEvent
import com.pimote.android.protocol.SessionReplacedEvent
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Unit tests for [reduceSessionEvent] — the pure event-reduction step that
 * drives [SessionRepository] state.
 */
class SessionReducerTest {

    private val emptySnap = SessionSnapshot(projects = emptyList(), sessions = emptyList())

    private fun snapWith(vararg sessions: SessionMeta) =
        SessionSnapshot(projects = emptyList(), sessions = sessions.toList())

    @Test
    fun `session_opened appends a new SessionMeta`() {
        val ev = SessionOpenedEvent(
            sessionId = "s1",
            folder = FolderInfo(path = "/work/repo", name = "repo"),
        )
        val out = reduceSessionEvent(emptySnap, ev)
        assertEquals(1, out.snapshot.sessions.size)
        val s = out.snapshot.sessions.single()
        assertEquals("s1", s.sessionId)
        assertEquals("/work/repo", s.folderPath)
        assertEquals("repo", s.folderName)
        assertEquals(false, s.archived)
        assertTrue(out.effects.isEmpty())
    }

    @Test
    fun `session_opened is idempotent for duplicate sessionId`() {
        val before = snapWith(
            SessionMeta("s1", "/p", "p", null, archived = false),
        )
        val ev = SessionOpenedEvent(sessionId = "s1", folder = FolderInfo(path = "/p", name = "p"))
        val out = reduceSessionEvent(before, ev)
        assertEquals(1, out.snapshot.sessions.size)
    }

    @Test
    fun `session_renamed updates name on the matching row`() {
        val before = snapWith(
            SessionMeta("s1", "/p", "p", null, archived = false),
            SessionMeta("s2", "/p", "p", "old", archived = false),
        )
        val ev = SessionRenamedEvent(sessionId = "s2", folderPath = "/p", name = "new")
        val out = reduceSessionEvent(before, ev)
        val s2 = out.snapshot.sessions.single { it.sessionId == "s2" }
        assertEquals("new", s2.name)
        // Other rows untouched.
        val s1 = out.snapshot.sessions.single { it.sessionId == "s1" }
        assertNull(s1.name)
        assertTrue(out.effects.isEmpty())
    }

    @Test
    fun `session_renamed is a no-op when sessionId unknown`() {
        val before = snapWith(SessionMeta("s1", "/p", "p", "n", archived = false))
        val out = reduceSessionEvent(before, SessionRenamedEvent("missing", "/p", "x"))
        assertEquals(before, out.snapshot)
    }

    @Test
    fun `session_archived archived=true removes the row`() {
        val before = snapWith(
            SessionMeta("s1", "/p", "p", null, archived = false),
            SessionMeta("s2", "/p", "p", null, archived = false),
        )
        val out = reduceSessionEvent(
            before, SessionArchivedEvent("s1", "/p", archived = true),
        )
        assertEquals(listOf("s2"), out.snapshot.sessions.map { it.sessionId })
        assertTrue(out.effects.isEmpty())
    }

    @Test
    fun `session_archived archived=false emits RefetchFolder effect`() {
        val before = snapWith(SessionMeta("s1", "/p", "p", null, archived = false))
        val out = reduceSessionEvent(
            before, SessionArchivedEvent("s2", "/p", archived = false),
        )
        // Snapshot drops the row (or leaves it absent); the effect drives canonical re-fetch.
        assertEquals(1, out.effects.size)
        val effect = out.effects.single()
        assertTrue(effect is SessionEffect.RefetchFolder)
        assertEquals("/p", (effect as SessionEffect.RefetchFolder).folderPath)
    }

    @Test
    fun `session_deleted removes the row`() {
        val before = snapWith(
            SessionMeta("s1", "/p", "p", null, archived = false),
        )
        val out = reduceSessionEvent(before, SessionDeletedEvent("s1", "/p"))
        assertTrue(out.snapshot.sessions.isEmpty())
        assertTrue(out.effects.isEmpty())
    }

    @Test
    fun `session_deleted is no-op when sessionId unknown`() {
        val before = snapWith(SessionMeta("s1", "/p", "p", null, archived = false))
        val out = reduceSessionEvent(before, SessionDeletedEvent("missing", "/p"))
        assertEquals(before, out.snapshot)
    }

    @Test
    fun `session_replaced swaps oldSessionId for newSessionId preserving metadata`() {
        val before = snapWith(
            SessionMeta("old", "/p", "p", "label", archived = false),
        )
        val ev = SessionReplacedEvent(
            oldSessionId = "old",
            newSessionId = "new",
            folder = FolderInfo(path = "/p", name = "p"),
        )
        val out = reduceSessionEvent(before, ev)
        val s = out.snapshot.sessions.single()
        assertEquals("new", s.sessionId)
        assertEquals("/p", s.folderPath)
        // Name preservation is part of the contract.
        assertEquals("label", s.name)
        assertTrue(out.effects.isEmpty())
    }

    @Test
    fun `session_replaced is no-op when oldSessionId not present`() {
        val before = snapWith(SessionMeta("s1", "/p", "p", null, archived = false))
        val ev = SessionReplacedEvent("missing", "new", FolderInfo("/p", "p"))
        val out = reduceSessionEvent(before, ev)
        assertEquals(before, out.snapshot)
    }

    @Test
    fun `reduction never modifies the projects list`() {
        val projects = listOf(ProjectMeta("/p", "p"))
        val snap = SessionSnapshot(
            projects = projects,
            sessions = listOf(SessionMeta("s", "/p", "p", null, archived = false)),
        )
        val out = reduceSessionEvent(snap, SessionDeletedEvent("s", "/p"))
        assertEquals(projects, out.snapshot.projects)
    }
}
