package com.pimote.android.session

import com.pimote.android.net.TypedResponse
import com.pimote.android.net.WsClient
import com.pimote.android.net.WsState
import com.pimote.android.protocol.FolderInfo
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

    private fun seedBootstrap(ws: FakeWs, folders: List<FolderInfo>, sessionsByPath: Map<String, List<SessionInfo>>) {
        // ListFolders
        ws.respondNext(TypedResponse("?", true, ListFoldersResponseData(folders), null))
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
}
