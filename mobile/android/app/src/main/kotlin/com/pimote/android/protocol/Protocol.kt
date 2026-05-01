package com.pimote.android.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/*
 * KEEP IN SYNC WITH: shared/src/protocol.ts
 *
 * This file mirrors the subset of the pimote wire protocol consumed by the
 * native Android client (voice-call commands/events + the session/folder
 * surface needed to drive the Telecom contact list). Any change to:
 *   - CallBindCommand / CallEndCommand / CallBindResponse
 *   - CallReadyEvent / CallEndedEvent / CallStatusEvent
 *   - OpenSessionCommand / OpenSessionResponseData
 *   - ListFoldersCommand / ListSessionsCommand
 *   - FolderInfo / SessionInfo
 *   - SessionOpenedEvent / SessionRenamedEvent / SessionArchivedEvent /
 *     SessionDeletedEvent / SessionReplacedEvent
 * MUST be reflected here. There is no codegen — keep both sides aligned by
 * hand. See docs/plans/native-android-client.md §Protocol DTOs.
 */

// ---------------------------------------------------------------------------
// Shared data types
// ---------------------------------------------------------------------------

@Serializable
data class FolderInfo(
    val path: String,
    val name: String,
    val activeSessionCount: Int = 0,
    val externalProcessCount: Int = 0,
)

@Serializable
data class SessionInfo(
    val id: String,
    val name: String? = null,
    val created: String,
    val modified: String,
    val messageCount: Int,
    val firstMessage: String? = null,
    val archived: Boolean? = null,
    val isOwnedByMe: Boolean? = null,
    val liveStatus: String? = null,
    val cwd: String? = null,
)

// ---------------------------------------------------------------------------
// Commands (client → server)
// ---------------------------------------------------------------------------

@Serializable
sealed interface PimoteCommand {
    val id: String
    val type: String
}

@Serializable
@SerialName("list_folders")
data class ListFoldersCommand(
    override val id: String,
    override val type: String = "list_folders",
) : PimoteCommand

@Serializable
@SerialName("list_sessions")
data class ListSessionsCommand(
    override val id: String,
    val folderPath: String,
    val includeArchived: Boolean? = null,
    override val type: String = "list_sessions",
) : PimoteCommand

@Serializable
@SerialName("open_session")
data class OpenSessionCommand(
    override val id: String,
    val folderPath: String,
    val sessionId: String? = null,
    val lastCursor: Long? = null,
    val force: Boolean? = null,
    override val type: String = "open_session",
) : PimoteCommand

@Serializable
@SerialName("call_bind")
data class CallBindCommand(
    override val id: String,
    val sessionId: String,
    val force: Boolean? = null,
    override val type: String = "call_bind",
) : PimoteCommand

@Serializable
@SerialName("call_end")
data class CallEndCommand(
    override val id: String,
    val sessionId: String,
    override val type: String = "call_end",
) : PimoteCommand

// ---------------------------------------------------------------------------
// Response payloads
// ---------------------------------------------------------------------------

/** Wire envelope for a request/response (matches PimoteResponse<T> on the TS side). */
@Serializable
data class PimoteResponse(
    val id: String,
    val success: Boolean,
    val data: JsonElement? = null,
    val error: String? = null,
)

@Serializable
data class OpenSessionResponseData(
    val sessionId: String,
    val folderPath: String? = null,
    val restoreMode: String? = null,
)

@Serializable
data class CallBindResponseData(
    val sessionId: String,
    val webrtcSignalUrl: String,
)

@Serializable
data class ListFoldersResponseData(val folders: List<FolderInfo>)

@Serializable
data class ListSessionsResponseData(val sessions: List<SessionInfo>)

/** Reason codes the server returns in [PimoteResponse.error] for a failed call_bind. */
object CallBindErrorCodes {
    const val SESSION_NOT_FOUND = "call_bind_failed_session_not_found"
    const val OWNED = "call_bind_failed_owned"
    const val INTERNAL = "call_bind_failed_internal"
}

// ---------------------------------------------------------------------------
// Events (server → client)
// ---------------------------------------------------------------------------

@Serializable(with = PimoteEventSerializer::class)
sealed interface PimoteEvent {
    val type: String
}

@Serializable
@SerialName("session_opened")
data class SessionOpenedEvent(
    val sessionId: String,
    val folder: FolderInfo,
    override val type: String = "session_opened",
) : PimoteEvent

@Serializable
@SerialName("session_renamed")
data class SessionRenamedEvent(
    val sessionId: String,
    val folderPath: String,
    val name: String,
    override val type: String = "session_renamed",
) : PimoteEvent

@Serializable
@SerialName("session_archived")
data class SessionArchivedEvent(
    val sessionId: String,
    val folderPath: String,
    val archived: Boolean,
    override val type: String = "session_archived",
) : PimoteEvent

@Serializable
@SerialName("session_deleted")
data class SessionDeletedEvent(
    val sessionId: String,
    val folderPath: String,
    override val type: String = "session_deleted",
) : PimoteEvent

@Serializable
@SerialName("session_replaced")
data class SessionReplacedEvent(
    val oldSessionId: String,
    val newSessionId: String,
    val folder: FolderInfo,
    override val type: String = "session_replaced",
) : PimoteEvent

@Serializable
@SerialName("call_bind_response")
data class CallBindResponseEvent(
    val id: String,
    val sessionId: String,
    val webrtcSignalUrl: String,
    override val type: String = "call_bind_response",
) : PimoteEvent

@Serializable
@SerialName("call_ready")
data class CallReadyEvent(
    val sessionId: String,
    override val type: String = "call_ready",
) : PimoteEvent

enum class CallEndReasonWire {
    @SerialName("user_hangup") USER_HANGUP,
    @SerialName("displaced") DISPLACED,
    @SerialName("server_ended") SERVER_ENDED,
    @SerialName("error") ERROR,
}

@Serializable
@SerialName("call_ended")
data class CallEndedEvent(
    val sessionId: String,
    val reason: CallEndReasonWire,
    override val type: String = "call_ended",
) : PimoteEvent

enum class CallStatusWire {
    @SerialName("binding") BINDING,
    @SerialName("ringing") RINGING,
    @SerialName("connected") CONNECTED,
    @SerialName("ended") ENDED,
}

@Serializable
@SerialName("call_status")
data class CallStatusEvent(
    val sessionId: String,
    val status: CallStatusWire,
    override val type: String = "call_status",
) : PimoteEvent

/**
 * Thrown when an event arrives whose `type` is not part of the v1 native
 * client subset. Callers (e.g. WsClient) are expected to filter the firehose
 * before decoding, or catch this and skip.
 */
class UnknownPimoteEventTypeException(val eventType: String?) :
    IllegalArgumentException("Unknown PimoteEvent type: $eventType")

// ---------------------------------------------------------------------------
// Polymorphic deserializer keyed by `type`
// ---------------------------------------------------------------------------

object PimoteEventSerializer : JsonContentPolymorphicSerializer<PimoteEvent>(PimoteEvent::class) {
    override fun selectDeserializer(element: JsonElement) =
        when (val t = element.jsonObject["type"]?.jsonPrimitive?.content) {
            "session_opened" -> SessionOpenedEvent.serializer()
            "session_renamed" -> SessionRenamedEvent.serializer()
            "session_archived" -> SessionArchivedEvent.serializer()
            "session_deleted" -> SessionDeletedEvent.serializer()
            "session_replaced" -> SessionReplacedEvent.serializer()
            "call_bind_response" -> CallBindResponseEvent.serializer()
            "call_ready" -> CallReadyEvent.serializer()
            "call_ended" -> CallEndedEvent.serializer()
            "call_status" -> CallStatusEvent.serializer()
            else -> throw UnknownPimoteEventTypeException(t)
        }
}
