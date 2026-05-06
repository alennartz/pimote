package com.pimote.android.session

import com.pimote.android.protocol.FolderInfo
import com.pimote.android.protocol.SessionOpenedEvent
import com.pimote.android.protocol.SessionReplacedEvent
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * Tests for the new clock-injected fields on [reduceSessionEvent].
 *
 * The original [SessionReducerTest] still covers the structural
 * reductions (sessionId / folderPath / archived / etc.). This file
 * pins the new behavior: `session_opened` seeds `created`/`modified`
 * from the injected clock, and `session_replaced` preserves the
 * originating row's rich metadata onto the new `sessionId`.
 *
 * Mirrors the PWA's expectation that newly-opened sessions sort to
 * the top of the list immediately and that replaced sessions retain
 * their message-count / first-message / cwd context until the next
 * canonical refetch.
 */
class SessionReducerExpandedTest {

    private val emptySnap = SessionSnapshot(projects = emptyList(), sessions = emptyList())
    private val fixedNow: () -> String = { "2026-04-05T10:00:00.000Z" }

    @Test
    fun `session_opened seeds created and modified from the injected clock`() {
        val ev = SessionOpenedEvent(
            sessionId = "s1",
            folder = FolderInfo(path = "/work/repo", name = "repo"),
        )
        val out = reduceSessionEvent(emptySnap, ev, fixedNow)
        val s = out.snapshot.sessions.single()
        assertEquals("2026-04-05T10:00:00.000Z", s.modified)
        assertEquals("2026-04-05T10:00:00.000Z", s.created)
    }

    @Test
    fun `session_opened seeds zero messageCount and null firstMessage and cwd`() {
        val ev = SessionOpenedEvent(
            sessionId = "s1",
            folder = FolderInfo(path = "/work/repo", name = "repo"),
        )
        val out = reduceSessionEvent(emptySnap, ev, fixedNow)
        val s = out.snapshot.sessions.single()
        assertEquals(0, s.messageCount)
        assertEquals(null, s.firstMessage)
        assertEquals(null, s.cwd)
    }

    @Test
    fun `session_replaced preserves rich metadata from the old row`() {
        val before = SessionSnapshot(
            projects = emptyList(),
            sessions = listOf(
                SessionMeta(
                    sessionId = "old",
                    folderPath = "/p",
                    folderName = "p",
                    name = "label",
                    archived = false,
                    modified = "2026-04-01T08:00:00.000Z",
                    created = "2026-04-01T08:00:00.000Z",
                    messageCount = 7,
                    firstMessage = "hello world",
                    cwd = "/p/sub",
                ),
            ),
        )
        val ev = SessionReplacedEvent(
            oldSessionId = "old",
            newSessionId = "new",
            folder = FolderInfo(path = "/p", name = "p"),
        )
        val out = reduceSessionEvent(before, ev, fixedNow)
        val s = out.snapshot.sessions.single()
        assertEquals("new", s.sessionId)
        assertEquals("label", s.name)
        assertEquals(7, s.messageCount)
        assertEquals("hello world", s.firstMessage)
        assertEquals("/p/sub", s.cwd)
        // Original timestamps preserved (no clock bump on replace).
        assertEquals("2026-04-01T08:00:00.000Z", s.modified)
        assertEquals("2026-04-01T08:00:00.000Z", s.created)
    }
}
