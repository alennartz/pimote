package com.pimote.android.session

import com.pimote.android.protocol.PimoteEvent
import com.pimote.android.protocol.SessionArchivedEvent
import com.pimote.android.protocol.SessionDeletedEvent
import com.pimote.android.protocol.SessionOpenedEvent
import com.pimote.android.protocol.SessionRenamedEvent
import com.pimote.android.protocol.SessionReplacedEvent
import kotlinx.coroutines.flow.StateFlow

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
fun reduceSessionEvent(snapshot: SessionSnapshot, event: PimoteEvent): ReducerResult = TODO("not implemented")
