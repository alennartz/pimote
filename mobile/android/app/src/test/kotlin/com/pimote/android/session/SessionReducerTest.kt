package com.pimote.android.session

import com.pimote.android.protocol.FoldersChangedEvent
import com.pimote.android.protocol.FolderInfo
import com.pimote.android.protocol.SessionArchivedEvent
import com.pimote.android.protocol.SessionDeletedEvent
import com.pimote.android.protocol.SessionOpenedEvent
import com.pimote.android.protocol.SessionRenamedEvent
import com.pimote.android.protocol.SessionReplacedEvent
import com.pimote.android.protocol.SessionStateChangedEvent
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

    /** Fixed clock for these tests; new-row timestamp values are pinned in [SessionReducerExpandedTest]. */
    private val fixedNow: () -> String = { "2026-01-01T00:00:00Z" }

    @Test
    fun `session_opened appends a new SessionMeta`() {
        val ev = SessionOpenedEvent(
            sessionId = "s1",
            folder = FolderInfo(path = "/work/repo", name = "repo"),
        )
        val out = reduceSessionEvent(emptySnap, ev, fixedNow)
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
        val out = reduceSessionEvent(before, ev, fixedNow)
        assertEquals(1, out.snapshot.sessions.size)
    }

    @Test
    fun `session_renamed updates name on the matching row`() {
        val before = snapWith(
            SessionMeta("s1", "/p", "p", null, archived = false),
            SessionMeta("s2", "/p", "p", "old", archived = false),
        )
        val ev = SessionRenamedEvent(sessionId = "s2", folderPath = "/p", name = "new")
        val out = reduceSessionEvent(before, ev, fixedNow)
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
        val out = reduceSessionEvent(before, SessionRenamedEvent("missing", "/p", "x"), fixedNow)
        assertEquals(before, out.snapshot)
    }

    @Test
    fun `session_archived archived=true removes the row`() {
        val before = snapWith(
            SessionMeta("s1", "/p", "p", null, archived = false),
            SessionMeta("s2", "/p", "p", null, archived = false),
        )
        val out = reduceSessionEvent(
            before, SessionArchivedEvent("s1", "/p", archived = true), fixedNow,
        )
        assertEquals(listOf("s2"), out.snapshot.sessions.map { it.sessionId })
        assertTrue(out.effects.isEmpty())
    }

    @Test
    fun `session_archived archived=false emits RefetchFolder effect`() {
        val before = snapWith(SessionMeta("s1", "/p", "p", null, archived = false))
        val out = reduceSessionEvent(
            before, SessionArchivedEvent("s2", "/p", archived = false), fixedNow,
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
        val out = reduceSessionEvent(before, SessionDeletedEvent("s1", "/p"), fixedNow)
        assertTrue(out.snapshot.sessions.isEmpty())
        assertTrue(out.effects.isEmpty())
    }

    @Test
    fun `session_deleted is no-op when sessionId unknown`() {
        val before = snapWith(SessionMeta("s1", "/p", "p", null, archived = false))
        val out = reduceSessionEvent(before, SessionDeletedEvent("missing", "/p"), fixedNow)
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
        val out = reduceSessionEvent(before, ev, fixedNow)
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
        val out = reduceSessionEvent(before, ev, fixedNow)
        assertEquals(before, out.snapshot)
    }

    @Test
    fun `reduction never modifies the projects list`() {
        val projects = listOf(ProjectMeta("/p", "p"))
        val snap = SessionSnapshot(
            projects = projects,
            sessions = listOf(SessionMeta("s", "/p", "p", null, archived = false)),
        )
        val out = reduceSessionEvent(snap, SessionDeletedEvent("s", "/p"), fixedNow)
        assertEquals(projects, out.snapshot.projects)
    }

    // ------------------------------------------- folders_changed deltas

    private fun snapWithEpoch(projects: List<ProjectMeta>, sessions: List<SessionMeta>, epoch: Long?) =
        SessionSnapshot(projects = projects, sessions = sessions, foldersEpoch = epoch)

    @Test
    fun `folders_changed upserts new and renamed folders and drops removed ones`() {
        val before = snapWithEpoch(
            projects = listOf(ProjectMeta("/p/old", "old"), ProjectMeta("/p/keep", "keep")),
            sessions = listOf(
                SessionMeta("s-old", "/p/old", "old", null, archived = false),
                SessionMeta("s-keep", "/p/keep", "keep", null, archived = false),
            ),
            epoch = 7,
        )
        val ev = FoldersChangedEvent(
            changed = listOf(
                FolderInfo("/p/keep", "keep-renamed"),
                FolderInfo("/p/new", "new"),
            ),
            removedPaths = listOf("/p/old"),
            epoch = 8,
        )
        val out = reduceSessionEvent(before, ev, fixedNow)

        assertEquals(listOf(ProjectMeta("/p/keep", "keep-renamed"), ProjectMeta("/p/new", "new")), out.snapshot.projects)
        // Sessions of removed folders go with the folder.
        assertEquals(listOf("s-keep"), out.snapshot.sessions.map { it.sessionId })
        assertEquals(8L, out.snapshot.foldersEpoch)
        assertTrue(out.effects.isEmpty())
    }

    @Test
    fun `folders_changed treats an archived changed row as a removal`() {
        val before = snapWithEpoch(
            projects = listOf(ProjectMeta("/p/a", "a")),
            sessions = listOf(SessionMeta("s1", "/p/a", "a", null, archived = false)),
            epoch = 3,
        )
        val ev = FoldersChangedEvent(
            changed = listOf(FolderInfo("/p/a", "a", archived = true)),
            removedPaths = emptyList(),
            epoch = 4,
        )
        val out = reduceSessionEvent(before, ev, fixedNow)
        assertTrue(out.snapshot.projects.isEmpty())
        assertTrue(out.snapshot.sessions.isEmpty())
    }

    @Test
    fun `folders_changed with a stale epoch is ignored`() {
        val before = snapWithEpoch(
            projects = listOf(ProjectMeta("/p", "p")),
            sessions = emptyList(),
            epoch = 10,
        )
        val ev = FoldersChangedEvent(
            changed = listOf(FolderInfo("/p/x", "x")),
            removedPaths = listOf("/p"),
            epoch = 10,
        )
        val out = reduceSessionEvent(before, ev, fixedNow)
        assertEquals(before, out.snapshot)
        assertTrue(out.effects.isEmpty())
    }

    @Test
    fun `folders_changed with an epoch gap emits RefetchFolders instead of applying`() {
        val before = snapWithEpoch(
            projects = listOf(ProjectMeta("/p", "p")),
            sessions = emptyList(),
            epoch = 5,
        )
        val ev = FoldersChangedEvent(
            changed = listOf(FolderInfo("/p/x", "x")),
            removedPaths = emptyList(),
            epoch = 8, // two deltas missed
        )
        val out = reduceSessionEvent(before, ev, fixedNow)
        // Projects untouched; the epoch advances so a refetch completion can supersede.
        assertEquals(listOf(ProjectMeta("/p", "p")), out.snapshot.projects)
        assertEquals(8L, out.snapshot.foldersEpoch)
        assertEquals(listOf<SessionEffect>(SessionEffect.RefetchFolders), out.effects)
    }

    @Test
    fun `folders_changed before any bootstrap applies directly`() {
        val ev = FoldersChangedEvent(
            changed = listOf(FolderInfo("/p/new", "new")),
            removedPaths = emptyList(),
            epoch = 1,
        )
        val out = reduceSessionEvent(emptySnap, ev, fixedNow)
        assertEquals(listOf(ProjectMeta("/p/new", "new")), out.snapshot.projects)
        assertEquals(1L, out.snapshot.foldersEpoch)
    }

    // ------------------------------------------- session_state_changed

    @Test
    fun `session_state_changed sets name firstMessage and messageCount`() {
        val before = snapWith(
            SessionMeta("s1", "/p", "p", null, archived = false, messageCount = 2, firstMessage = "old"),
        )
        val ev = SessionStateChangedEvent(
            sessionId = "s1",
            folderPath = "/p",
            sessionName = "Named",
            firstMessage = "hello world",
            messageCount = 12,
        )
        val out = reduceSessionEvent(before, ev, fixedNow)
        val s = out.snapshot.sessions.single()
        assertEquals("Named", s.name)
        assertEquals("hello world", s.firstMessage)
        assertEquals(12, s.messageCount)
    }

    @Test
    fun `session_state_changed blank name clears absent fields keep`() {
        val before = snapWith(
            SessionMeta("s1", "/p", "p", "Old", archived = false, messageCount = 2, firstMessage = "old"),
        )
        val ev = SessionStateChangedEvent(sessionId = "s1", folderPath = "/p", sessionName = "")
        val out = reduceSessionEvent(before, ev, fixedNow)
        val s = out.snapshot.sessions.single()
        assertNull(s.name)
        assertEquals("old", s.firstMessage)
        assertEquals(2, s.messageCount)
    }

    @Test
    fun `session_state_changed is a no-op for unknown sessions`() {
        val before = snapWith(SessionMeta("s1", "/p", "p", null, archived = false))
        val ev = SessionStateChangedEvent(sessionId = "other", folderPath = "/p", sessionName = "x")
        val out = reduceSessionEvent(before, ev, fixedNow)
        assertEquals(before, out.snapshot)
    }
}
