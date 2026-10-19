package com.pimote.android.session

import com.pimote.android.net.TypedResponse
import com.pimote.android.net.WsClient
import com.pimote.android.net.WsState
import com.pimote.android.protocol.FolderInfo
import com.pimote.android.protocol.FoldersChangedEvent
import com.pimote.android.protocol.ListFoldersCommand
import com.pimote.android.protocol.ListFoldersResponseData
import com.pimote.android.protocol.ListSessionsCommand
import com.pimote.android.protocol.ListSessionsResponseData
import com.pimote.android.protocol.PimoteCommand
import com.pimote.android.protocol.PimoteEvent
import com.pimote.android.protocol.SessionArchivedEvent
import com.pimote.android.protocol.SessionInfo
import com.pimote.android.protocol.SessionOpenedEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.KSerializer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Behavioral tests for [SessionRepositoryImpl] orchestration: bootstrap on
 * start, re-bootstrap on WS reconnect, and reaction to
 * [SessionEffect.RefetchFolder] effects emitted by [reduceSessionEvent].
 *
 * Pure event-reducer behavior is covered separately in [SessionReducerTest].
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionRepositoryImplTest {

    private class FakeWs : WsClient {
        override val state = MutableStateFlow<WsState>(WsState.Connected)
        override val lastFailure = MutableStateFlow<String?>(null)
        private val _events = MutableSharedFlow<PimoteEvent>(extraBufferCapacity = 32)
        override val events: SharedFlow<PimoteEvent> = _events
        val sent = mutableListOf<PimoteCommand>()
        private val pending = ArrayDeque<CompletableDeferred<TypedResponse<*>>>()
        @Suppress("UNCHECKED_CAST")
        override suspend fun <T> request(
            command: PimoteCommand,
            responseSerializer: KSerializer<T>,
            timeoutMillis: Long,
        ): TypedResponse<T> {
            sent.add(command)
            val d = CompletableDeferred<TypedResponse<*>>()
            pending.addLast(d)
            return d.await() as TypedResponse<T>
        }
        override suspend fun send(command: PimoteCommand) { sent.add(command) }
        override fun connect(pimoteOrigin: String) {}
        override fun disconnect() {}
        suspend fun emit(ev: PimoteEvent) = _events.emit(ev)
        @Suppress("UNCHECKED_CAST")
        fun <T> respondNext(r: TypedResponse<T>) {
            (pending.removeFirst() as CompletableDeferred<TypedResponse<*>>).complete(r)
        }
        fun pendingCount() = pending.size
    }

    private fun seedBootstrap(ws: FakeWs, folders: List<FolderInfo>, sessionsByPath: Map<String, List<SessionInfo>>, epoch: Long = 5) {
        // ListFolders
        ws.respondNext(TypedResponse("?", true, ListFoldersResponseData(folders, more = false, epoch = epoch), null))
        // Then a list_sessions per folder; respond in matching order.
        folders.forEach { f ->
            ws.respondNext(TypedResponse("?", true, ListSessionsResponseData(sessionsByPath[f.path].orEmpty()), null))
        }
    }

    @Test
    fun `start triggers bootstrap of folders and sessions`() = runTest {
        val ws = FakeWs()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val repo = SessionRepositoryImpl(ws, scope)

        repo.start()
        advanceUntilIdle()

        val first = ws.sent.first()
        assertTrue(first is ListFoldersCommand)

        seedBootstrap(
            ws,
            folders = listOf(FolderInfo("/work/repo", "repo")),
            sessionsByPath = mapOf("/work/repo" to listOf(
                SessionInfo(id = "s1", name = "feat", created = "t", modified = "t", messageCount = 0),
            )),
        )
        advanceUntilIdle()

        assertEquals(listOf(ProjectMeta("/work/repo", "repo")), repo.projects.value)
        assertEquals(1, repo.sessions.value.size)
        assertEquals("s1", repo.sessions.value[0].sessionId)
    }

    @Test
    fun `RefetchFolder effect drives a list_sessions request and merges`() = runTest {
        val ws = FakeWs()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val repo = SessionRepositoryImpl(ws, scope)
        repo.start()
        advanceUntilIdle()
        seedBootstrap(
            ws,
            folders = listOf(FolderInfo("/p", "p")),
            sessionsByPath = mapOf("/p" to emptyList()),
        )
        advanceUntilIdle()

        // Unarchive event \u2192 reducer emits RefetchFolder \u2192 repo issues list_sessions.
        ws.emit(SessionArchivedEvent(sessionId = "s2", folderPath = "/p", archived = false))
        advanceUntilIdle()

        val refetch = ws.sent.last { it is ListSessionsCommand } as ListSessionsCommand
        assertEquals("/p", refetch.folderPath)

        // Server returns the unarchived session.
        ws.respondNext(
            TypedResponse(
                refetch.id, true,
                ListSessionsResponseData(listOf(
                    SessionInfo(id = "s2", name = "x", created = "t", modified = "t", messageCount = 0),
                )),
                null,
            ),
        )
        advanceUntilIdle()

        assertTrue(repo.sessions.value.any { it.sessionId == "s2" })
    }

    @Test
    fun `WS reconnect re-bootstraps`() = runTest {
        val ws = FakeWs()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val repo = SessionRepositoryImpl(ws, scope)
        repo.start()
        advanceUntilIdle()
        seedBootstrap(ws, listOf(FolderInfo("/p", "p")), mapOf("/p" to emptyList()))
        advanceUntilIdle()

        val sentBefore = ws.sent.size

        // Simulate a reconnect cycle.
        ws.state.value = WsState.Reconnecting(attempt = 1, nextDelayMs = 100)
        ws.state.value = WsState.Connected
        advanceUntilIdle()

        // A fresh bootstrap was issued: another ListFoldersCommand appeared.
        assertTrue(ws.sent.size > sentBefore)
        assertTrue(ws.sent.drop(sentBefore).any { it is ListFoldersCommand })
    }

    @Test
    fun `live event applies pure reducer`() = runTest {
        val ws = FakeWs()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val repo = SessionRepositoryImpl(ws, scope)
        repo.start()
        advanceUntilIdle()
        seedBootstrap(ws, listOf(FolderInfo("/p", "p")), mapOf("/p" to emptyList()))
        advanceUntilIdle()

        ws.emit(SessionOpenedEvent(sessionId = "newS", folder = FolderInfo("/p", "p")))
        advanceUntilIdle()

        assertTrue(repo.sessions.value.any { it.sessionId == "newS" })
    }

    @Test
    fun `bootstrap pages list_folders until more is false`() = runTest {
        val ws = FakeWs()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val repo = SessionRepositoryImpl(ws, scope)
        repo.start()
        advanceUntilIdle()

        // Page 1 of 2.
        val page1 = ws.sent.filterIsInstance<ListFoldersCommand>().single()
        assertEquals(0, page1.offset)
        assertEquals(200, page1.limit)
        ws.respondNext(
            TypedResponse(
                "?", true,
                ListFoldersResponseData(
                    folders = listOf(FolderInfo("/p/a", "a"), FolderInfo("/p/b", "b")),
                    more = true,
                    epoch = 5,
                ),
                null,
            ),
        )
        advanceUntilIdle()

        // Page 2 continues at the consumed offset.
        val page2 = ws.sent.filterIsInstance<ListFoldersCommand>().last()
        assertEquals(2, page2.offset)
        ws.respondNext(
            TypedResponse(
                "?", true,
                ListFoldersResponseData(folders = listOf(FolderInfo("/p/c", "c")), more = false, epoch = 5),
                null,
            ),
        )
        // One list_sessions per folder across both pages.
        listOf("/p/a", "/p/b", "/p/c").forEach { _ ->
            ws.respondNext(TypedResponse("?", true, ListSessionsResponseData(emptyList()), null))
        }
        advanceUntilIdle()

        assertEquals(
            listOf(ProjectMeta("/p/a", "a"), ProjectMeta("/p/b", "b"), ProjectMeta("/p/c", "c")),
            repo.projects.value,
        )
    }

    @Test
    fun `folders_changed delta applies live and an epoch gap re-bootstraps`() = runTest {
        val ws = FakeWs()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val repo = SessionRepositoryImpl(ws, scope)
        repo.start()
        advanceUntilIdle()
        seedBootstrap(
            ws,
            folders = listOf(FolderInfo("/p", "p")),
            sessionsByPath = mapOf("/p" to emptyList()),
        )
        advanceUntilIdle()
        val bootstrapsBefore = ws.sent.count { it is ListFoldersCommand }

        // Contiguous delta: new folder appears without any request.
        ws.emit(FoldersChangedEvent(changed = listOf(FolderInfo("/q", "q")), removedPaths = emptyList(), epoch = 6))
        advanceUntilIdle()
        assertEquals(bootstrapsBefore, ws.sent.count { it is ListFoldersCommand })
        assertTrue(repo.projects.value.contains(ProjectMeta("/q", "q")))

        // Gap (6 → 9): two deltas missed — full re-bootstrap.
        ws.emit(FoldersChangedEvent(changed = listOf(FolderInfo("/r", "r")), removedPaths = emptyList(), epoch = 9))
        advanceUntilIdle()
        val refetch = ws.sent.filterIsInstance<ListFoldersCommand>().last()
        ws.respondNext(
            TypedResponse("?", true, ListFoldersResponseData(folders = listOf(FolderInfo("/p", "p"), FolderInfo("/q", "q"), FolderInfo("/r", "r")), more = false, epoch = 9), null),
        )
        listOf("/p", "/q", "/r").forEach { _ ->
            ws.respondNext(TypedResponse("?", true, ListSessionsResponseData(emptyList()), null))
        }
        advanceUntilIdle()

        assertTrue(ws.sent.count { it is ListFoldersCommand } > bootstrapsBefore)
        assertEquals(3, repo.projects.value.size)
    }

    @Test
    fun `removeSession drops the row`() = runTest {
        val ws = FakeWs()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val repo = SessionRepositoryImpl(ws, scope)
        repo.start()
        advanceUntilIdle()
        seedBootstrap(
            ws,
            folders = listOf(FolderInfo("/p", "p")),
            sessionsByPath = mapOf("/p" to listOf(
                SessionInfo(id = "s1", name = null, created = "t", modified = "t", messageCount = 1),
                SessionInfo(id = "s2", name = null, created = "t", modified = "t", messageCount = 1),
            )),
        )
        advanceUntilIdle()
        assertEquals(2, repo.sessions.value.size)

        repo.removeSession("s1")

        assertEquals(listOf("s2"), repo.sessions.value.map { it.sessionId })
    }
}
