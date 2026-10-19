package com.pimote.android.session

import com.pimote.android.protocol.FoldersChangedEvent
import com.pimote.android.protocol.FolderInfo
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
import com.pimote.android.protocol.SessionStateChangedEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.runningFold
import kotlinx.coroutines.launch
import com.pimote.android.net.WsState

data class ProjectMeta(val folderPath: String, val folderName: String)

/**
 * Held metadata for one unarchived session. Fields beyond the original
 * five (`sessionId`, `folderPath`, `folderName`, `name`, `archived`) mirror
 * the wire's `SessionInfo` and drive the in-app contacts list (recency
 * sort, message count, cwd hint, first-message fallback).
 *
 * `liveStatus` is intentionally NOT mirrored — the
 * Android contacts screen does not surface remote-active state, and the
 * archived filter happens at the repository level so the UI never needs
 * to render archived contacts.
 */
data class SessionMeta(
    val sessionId: String,
    val folderPath: String,
    val folderName: String,
    val name: String?,
    val archived: Boolean,
    /** ISO-8601 UTC timestamp from the server, or a clock-injected fallback for newly-opened rows. */
    val modified: String = "",
    /** ISO-8601 UTC timestamp from the server, or a clock-injected fallback for newly-opened rows. */
    val created: String = "",
    val messageCount: Int = 0,
    val firstMessage: String? = null,
    val cwd: String? = null,
)

/**
 * Held state for projects and unarchived sessions, driven by WS events.
 *
 * Bootstrap (on [start] and on every WS reconnect):
 * - `wsClient.request(ListFoldersCommand)` pages the windowed listing
 *   (limit 200, `more`-driven) and seeds [projects].
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
 * | `session_state_changed`                  | Update `name`/`firstMessage`/`messageCount` on the row.  |
 * | `folders_changed`                        | Upsert/remove projects (delta); epoch gap → re-bootstrap.|
 * | `session_closed`                         | Ignored (not displayed in v1 contact list).              |
 *
 * Reconnect handling: on `WsState` transition `Reconnecting → Connected` the
 * repository automatically calls [refresh] to re-bootstrap.
 *
 * The folder set follows `folders_changed` deltas while connected; the epoch
 * they carry must stay contiguous with the bootstrap epoch — a gap means a
 * delta was missed and triggers a full re-bootstrap.
 */
interface SessionRepository {
    val projects: StateFlow<List<ProjectMeta>>
    val sessions: StateFlow<List<SessionMeta>> // unarchived only
    fun start()
    fun stop()
    suspend fun refresh()

    /** Drop one session row (e.g. the server reported the session gone for
     *  good — a definitive `call_bind_failed_session_not_found`). */
    fun removeSession(sessionId: String)
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
    /** Folder-listing epoch of the last bootstrap or applied delta; null before the first bootstrap. */
    val foldersEpoch: Long? = null,
)

/** Side-effect requests emitted by [reduceSessionEvent]. */
sealed interface SessionEffect {
    /** Repository should call list_sessions for this folder and merge results. */
    data class RefetchFolder(val folderPath: String) : SessionEffect

    /** Repository should re-bootstrap the whole folder/session set (missed folders_changed delta). */
    object RefetchFolders : SessionEffect
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
 * - [SessionStateChangedEvent]: update `name` (absent keeps, blank clears,
 *   value sets), `firstMessage`, and `messageCount` on the matching row.
 * - [FoldersChangedEvent]: upsert `changed` rows into the projects list, drop
 *   `removedPaths` (and rows the delta reports as archived) plus their
 *   sessions. A stale epoch (≤ the snapshot's) is ignored; an epoch gap (> +1)
 *   emits [SessionEffect.RefetchFolders] instead of applying a partial view.
 *
 * The projects list is event-maintained between bootstraps.
 */
fun reduceSessionEvent(
    snapshot: SessionSnapshot,
    event: PimoteEvent,
    now: () -> String,
): ReducerResult {
    val sessions = snapshot.sessions
    return when (event) {
        is SessionOpenedEvent -> {
            if (sessions.any { it.sessionId == event.sessionId }) {
                ReducerResult(snapshot, emptyList())
            } else {
                val stamp = now()
                val added = sessions + SessionMeta(
                    sessionId = event.sessionId,
                    folderPath = event.folder.path,
                    folderName = event.folder.name,
                    name = null,
                    archived = false,
                    modified = stamp,
                    created = stamp,
                    messageCount = 0,
                    firstMessage = null,
                    cwd = null,
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
                // `copy` already preserves modified/created/messageCount/firstMessage/cwd
                // verbatim; we override only the identity-and-folder fields. The rich
                // metadata stays attached to the new sessionId until the next
                // canonical refetch overwrites it.
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
        is FoldersChangedEvent -> {
            val last = snapshot.foldersEpoch
            when {
                last != null && event.epoch <= last -> {
                    // Stale replay — the bootstrap or a later delta already passed this point.
                    ReducerResult(snapshot, emptyList())
                }
                last != null && event.epoch > last + 1 -> {
                    // A delta was missed; applying only this one would show a partial set.
                    ReducerResult(snapshot.copy(foldersEpoch = event.epoch), listOf(SessionEffect.RefetchFolders))
                }
                else -> {
                    val removed = buildSet {
                        addAll(event.removedPaths)
                        addAll(event.changed.filter { it.archived }.map { it.path })
                    }
                    val changedByPath = event.changed.filterNot { it.archived }.associateBy { it.path }
                    val kept = snapshot.projects
                        .filterNot { it.folderPath in removed }
                        .map { p -> changedByPath[p.folderPath]?.let { ProjectMeta(it.path, it.name) } ?: p }
                    val added = changedByPath.values
                        .filter { c -> kept.none { it.folderPath == c.path } }
                        .map { ProjectMeta(it.path, it.name) }
                    val sessions = snapshot.sessions.filterNot { it.folderPath in removed }
                    ReducerResult(SessionSnapshot(kept + added, sessions, event.epoch), emptyList())
                }
            }
        }
        is SessionStateChangedEvent -> {
            val idx = sessions.indexOfFirst { it.sessionId == event.sessionId }
            if (idx < 0) {
                ReducerResult(snapshot, emptyList())
            } else {
                val row = sessions[idx]
                val updated = sessions.toMutableList()
                updated[idx] = row.copy(
                    name = when {
                        event.sessionName == null -> row.name
                        event.sessionName.isBlank() -> null
                        else -> event.sessionName
                    },
                    firstMessage = event.firstMessage ?: row.firstMessage,
                    messageCount = event.messageCount ?: row.messageCount,
                )
                ReducerResult(snapshot.copy(sessions = updated), emptyList())
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
    private val nowProvider: () -> String = { java.time.Instant.now().toString() },
) : SessionRepository {
    private companion object {
        /** Server clamps to [1, 200]; ask for the max window to halve round trips. */
        const val FOLDER_PAGE_LIMIT = 200
    }

    private val _projects = MutableStateFlow<List<ProjectMeta>>(emptyList())
    private val _sessions = MutableStateFlow<List<SessionMeta>>(emptyList())
    private val _foldersEpoch = MutableStateFlow<Long?>(null)

    override val projects: StateFlow<List<ProjectMeta>> = _projects.asStateFlow()
    override val sessions: StateFlow<List<SessionMeta>> = _sessions.asStateFlow()

    // The repository's collectors (events reducer + ws-state-edge refresher)
    // share a child scope parented from the constructor-injected scope.
    // start() installs a fresh scope; stop() cancels it, which kills all
    // children together. Held in a MutableStateFlow so the field itself is
    // not a raw mutable var — transitions go through atomic value writes.
    private val collectors = MutableStateFlow<CoroutineScope?>(null)

    override fun start() {
        if (collectors.value != null) return
        val child = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
        collectors.value = child
        child.launch(Dispatchers.Unconfined) {
            wsClient.events.collect { ev ->
                val snap = SessionSnapshot(_projects.value, _sessions.value, _foldersEpoch.value)
                val out = reduceSessionEvent(snap, ev, nowProvider)
                if (out.snapshot != snap) {
                    _projects.value = out.snapshot.projects
                    _sessions.value = out.snapshot.sessions
                    _foldersEpoch.value = out.snapshot.foldersEpoch
                }
                for (effect in out.effects) {
                    when (effect) {
                        is SessionEffect.RefetchFolder -> child.launch(Dispatchers.Unconfined) { refetchFolder(effect.folderPath) }
                        is SessionEffect.RefetchFolders -> child.launch(Dispatchers.Unconfined) { runCatching { refresh() } }
                    }
                }
            }
        }
        // Refresh on any non-Connected → Connected transition. The initial
        // Disconnected/Connecting → Connected case is the common one (cold
        // app launch); the Reconnecting → Connected case covers transient
        // drops. runningFold keeps the previous emission immutably inside
        // the pipeline so we don't need a `var prev` capture inside the
        // collector lambda.
        child.launch(Dispatchers.Unconfined) {
            // StateFlow already deduplicates equal consecutive emissions.
            wsClient.state
                .runningFold<WsState, Pair<WsState?, WsState?>>(null to null) { acc, cur -> acc.second to cur }
                .filter { (prev, cur) -> prev !is WsState.Connected && cur is WsState.Connected }
                .collect { runCatching { refresh() } }
        }
    }

    override fun stop() {
        collectors.value?.cancel()
        collectors.value = null
    }

    override fun removeSession(sessionId: String) {
        _sessions.value = _sessions.value.filterNot { it.sessionId == sessionId }
    }

    override suspend fun refresh() {
        com.pimote.android.util.L.d("Session", "refresh()")
        val folders = mutableListOf<FolderInfo>()
        var epoch: Long? = null
        try {
            // Page the windowed listing until `more` is false — the default
            // window is 100 rows and would silently truncate past it.
            var offset = 0
            var more = true
            while (more) {
                val resp = wsClient.request(
                    ListFoldersCommand(
                        id = java.util.UUID.randomUUID().toString(),
                        offset = offset,
                        limit = FOLDER_PAGE_LIMIT,
                    ),
                    ListFoldersResponseData.serializer(),
                )
                val data = resp.data ?: break
                folders += data.folders
                epoch = data.epoch
                more = data.more && data.folders.isNotEmpty()
                offset += data.folders.size
            }
        } catch (e: Throwable) {
            com.pimote.android.util.L.w("Session", "refresh: list_folders failed: ${e.message}", e)
            throw e
        }
        com.pimote.android.util.L.i("Session", "refresh: ${folders.size} folder(s)")
        _projects.value = folders.map { ProjectMeta(it.path, it.name) }
        _foldersEpoch.value = epoch

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
                    modified = s.modified,
                    created = s.created,
                    messageCount = s.messageCount,
                    firstMessage = s.firstMessage,
                    cwd = s.cwd,
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
                modified = it.modified,
                created = it.created,
                messageCount = it.messageCount,
                firstMessage = it.firstMessage,
                cwd = it.cwd,
            )
        }
        _sessions.value = keep + refreshed
    }
}
