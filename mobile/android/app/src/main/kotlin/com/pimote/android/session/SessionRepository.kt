package com.pimote.android.session

import com.pimote.android.protocol.ListFoldersCommand
import com.pimote.android.protocol.ListFoldersResponseData
import com.pimote.android.protocol.ListSessionsCommand
import com.pimote.android.protocol.ListSessionsResponseData
import com.pimote.android.protocol.PimoteEvent
import com.pimote.android.protocol.SessionArchivedEvent
import com.pimote.android.protocol.SessionDeletedEvent
import com.pimote.android.protocol.SessionOpenedEvent
import com.pimote.android.protocol.SessionRenamedEvent
import com.pimote.android.protocol.SessionReplacedEvent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import com.pimote.android.net.WsState

data class ProjectMeta(val folderPath: String, val folderName: String)

data class SessionMeta(
    val sessionId: String,
    val folderPath: String,
    val folderName: String,
    val name: String?,
    val archived: Boolean,
)

/**
 * Held state for projects and unarchived sessions, driven by WS events.
 *
 * Bootstrap (on [start] and on every WS reconnect):
 * - `wsClient.request(ListFoldersCommand)` seeds [projects].
 * - For each folder, `wsClient.request(ListSessionsCommand(folderPath, includeArchived = false))`
 *   concurrently → unioned into [sessions].
 *
 * Live event reduction (subscribe to `wsClient.events`):
 *
 * | Event                                    | Action                                                   |
 * | ---------------------------------------- | -------------------------------------------------------- |
 * | `session_opened`                         | Add a [SessionMeta] (folderName from `event.folder.name`).
 * | `session_renamed`                        | Update `name` on matching `sessionId`.                   |
 * | `session_archived { archived: true }`    | Remove.                                                  |
 * | `session_archived { archived: false }`   | Re-fetch matching folder via `list_sessions` and merge.  |
 * | `session_deleted`                        | Remove.                                                  |
 * | `session_replaced`                       | Replace `oldSessionId` entry with `newSessionId` entry.  |
 * | `session_state_changed`, `session_closed`| Ignored (not displayed in v1 contact list).              |
 *
 * Reconnect handling: on `WsState` transition `Reconnecting → Connected` the
 * repository automatically calls [refresh] to re-bootstrap.
 *
 * Folder set is bootstrap-only — new projects appear after reconnect or
 * manual [refresh].
 */
interface SessionRepository {
    val projects: StateFlow<List<ProjectMeta>>
    val sessions: StateFlow<List<SessionMeta>> // unarchived only
    fun start()
    fun stop()
    suspend fun refresh()
}

/**
 * Pure event-reduction step. Given the current snapshot and a single event,
 * returns the next snapshot plus any side-effect requests that need to fire
 * (e.g., a `list_sessions` re-fetch for an unarchive event).
 *
 * Extracted from [SessionRepository] so the reduction logic is unit-testable
 * without a real WsClient.
 */
data class SessionSnapshot(
    val projects: List<ProjectMeta>,
    val sessions: List<SessionMeta>,
)

/** Side-effect requests emitted by [reduceSessionEvent]. */
sealed interface SessionEffect {
    /** Repository should call list_sessions for this folder and merge results. */
    data class RefetchFolder(val folderPath: String) : SessionEffect
}

data class ReducerResult(
    val snapshot: SessionSnapshot,
    val effects: List<SessionEffect>,
)

/**
 * Apply [event] to [snapshot]. Unknown / ignored events return [snapshot]
 * unchanged with no effects. Pure function: no I/O.
 *
 * Reductions:
 * - [SessionOpenedEvent]: append a new [SessionMeta] (archived = false). If a
 *   row with the same `sessionId` already exists, no-op.
 * - [SessionRenamedEvent]: update `name` on the matching row, no-op if absent.
 * - [SessionArchivedEvent] with `archived = true`: drop the row.
 * - [SessionArchivedEvent] with `archived = false`: drop the row from the
 *   snapshot AND emit a [SessionEffect.RefetchFolder] so the repository can
 *   re-fetch and merge canonical state.
 * - [SessionDeletedEvent]: drop the row.
 * - [SessionReplacedEvent]: swap the `oldSessionId` row for one keyed by
 *   `newSessionId`, preserving folderName/name/archived. No-op if the old row
 *   isn't present.
 *
 * Projects list is never modified by event reduction — projects are
 * bootstrap-only.
 */
fun reduceSessionEvent(snapshot: SessionSnapshot, event: PimoteEvent): ReducerResult {
    val sessions = snapshot.sessions
    return when (event) {
        is SessionOpenedEvent -> {
            if (sessions.any { it.sessionId == event.sessionId }) {
                ReducerResult(snapshot, emptyList())
            } else {
                val added = sessions + SessionMeta(
                    sessionId = event.sessionId,
                    folderPath = event.folder.path,
                    folderName = event.folder.name,
                    name = null,
                    archived = false,
                )
                ReducerResult(snapshot.copy(sessions = added), emptyList())
            }
        }
        is SessionRenamedEvent -> {
            if (sessions.none { it.sessionId == event.sessionId }) {
                ReducerResult(snapshot, emptyList())
            } else {
                val updated = sessions.map {
                    if (it.sessionId == event.sessionId) it.copy(name = event.name) else it
                }
                ReducerResult(snapshot.copy(sessions = updated), emptyList())
            }
        }
        is SessionArchivedEvent -> {
            val filtered = sessions.filterNot { it.sessionId == event.sessionId }
            val effects = if (!event.archived) listOf(SessionEffect.RefetchFolder(event.folderPath)) else emptyList()
            ReducerResult(snapshot.copy(sessions = filtered), effects)
        }
        is SessionDeletedEvent -> {
            if (sessions.none { it.sessionId == event.sessionId }) {
                ReducerResult(snapshot, emptyList())
            } else {
                val filtered = sessions.filterNot { it.sessionId == event.sessionId }
                ReducerResult(snapshot.copy(sessions = filtered), emptyList())
            }
        }
        is SessionReplacedEvent -> {
            val idx = sessions.indexOfFirst { it.sessionId == event.oldSessionId }
            if (idx < 0) {
                ReducerResult(snapshot, emptyList())
            } else {
                val old = sessions[idx]
                val replaced = sessions.toMutableList().also {
                    it[idx] = old.copy(
                        sessionId = event.newSessionId,
                        folderPath = event.folder.path,
                        folderName = event.folder.name,
                    )
                }
                ReducerResult(snapshot.copy(sessions = replaced), emptyList())
            }
        }
        else -> ReducerResult(snapshot, emptyList())
    }
}

/**
 * Production [SessionRepository]. Subscribes to `wsClient.events`, applies
 * [reduceSessionEvent], handles emitted [SessionEffect]s (e.g.
 * [SessionEffect.RefetchFolder]), and re-bootstraps on reconnect. Tests
 * construct it with a fake WsClient.
 */
class SessionRepositoryImpl(
    private val wsClient: com.pimote.android.net.WsClient,
    private val scope: kotlinx.coroutines.CoroutineScope,
) : SessionRepository {
    private val _projects = MutableStateFlow<List<ProjectMeta>>(emptyList())
    private val _sessions = MutableStateFlow<List<SessionMeta>>(emptyList())

    override val projects: StateFlow<List<ProjectMeta>> = _projects.asStateFlow()
    override val sessions: StateFlow<List<SessionMeta>> = _sessions.asStateFlow()

    private var eventJob: Job? = null
    private var stateJob: Job? = null
    private var bootstrapJob: Job? = null

    override fun start() {
        if (eventJob?.isActive == true) return
        eventJob = scope.launch(Dispatchers.Unconfined) {
            wsClient.events.collect { ev ->
                val snap = SessionSnapshot(_projects.value, _sessions.value)
                val out = reduceSessionEvent(snap, ev)
                if (out.snapshot != snap) {
                    _projects.value = out.snapshot.projects
                    _sessions.value = out.snapshot.sessions
                }
                for (effect in out.effects) {
                    when (effect) {
                        is SessionEffect.RefetchFolder -> scope.launch(Dispatchers.Unconfined) { refetchFolder(effect.folderPath) }
                    }
                }
            }
        }
        stateJob = scope.launch(Dispatchers.Unconfined) {
            var prev: WsState? = null
            wsClient.state.collect { cur ->
                if (prev is WsState.Reconnecting && cur is WsState.Connected) {
                    runCatching { refresh() }
                }
                prev = cur
            }
        }
        bootstrapJob = scope.launch(Dispatchers.Unconfined) { runCatching { refresh() } }
    }

    override fun stop() {
        eventJob?.cancel(); eventJob = null
        stateJob?.cancel(); stateJob = null
        bootstrapJob?.cancel(); bootstrapJob = null
    }

    override suspend fun refresh() {
        val foldersResp = wsClient.request(
            ListFoldersCommand(id = java.util.UUID.randomUUID().toString()),
            ListFoldersResponseData.serializer(),
        )
        val folders = foldersResp.data?.folders.orEmpty()
        _projects.value = folders.map { ProjectMeta(it.path, it.name) }

        val merged = LinkedHashMap<String, SessionMeta>()
        // Preserve any sessions for folders we don't have in the bootstrap; replace those we do.
        val foldersSet = folders.map { it.path }.toSet()
        _sessions.value.forEach { existing ->
            if (existing.folderPath !in foldersSet) merged[existing.sessionId] = existing
        }
        val byFolder: List<Pair<String, ListSessionsResponseData?>> = coroutineScope {
            folders.map { f ->
                async(Dispatchers.Unconfined) {
                    val r = wsClient.request(
                        ListSessionsCommand(
                            id = java.util.UUID.randomUUID().toString(),
                            folderPath = f.path,
                            includeArchived = false,
                        ),
                        ListSessionsResponseData.serializer(),
                    )
                    f.path to r.data
                }
            }.awaitAll()
        }
        for ((path, data) in byFolder) {
            val folder = folders.first { it.path == path }
            data?.sessions?.forEach { s ->
                merged[s.id] = SessionMeta(
                    sessionId = s.id,
                    folderPath = path,
                    folderName = folder.name,
                    name = s.name,
                    archived = s.archived ?: false,
                )
            }
        }
        _sessions.value = merged.values.toList()
    }

    private suspend fun refetchFolder(folderPath: String) {
        val folder = _projects.value.firstOrNull { it.folderPath == folderPath } ?: return
        val r = runCatching {
            wsClient.request(
                ListSessionsCommand(
                    id = java.util.UUID.randomUUID().toString(),
                    folderPath = folderPath,
                    includeArchived = false,
                ),
                ListSessionsResponseData.serializer(),
            )
        }.getOrNull() ?: return
        val list = r.data?.sessions.orEmpty()
        val keep = _sessions.value.filterNot { it.folderPath == folderPath }
        val refreshed = list.map {
            SessionMeta(
                sessionId = it.id,
                folderPath = folderPath,
                folderName = folder.folderName,
                name = it.name,
                archived = it.archived ?: false,
            )
        }
        _sessions.value = keep + refreshed
    }
}
