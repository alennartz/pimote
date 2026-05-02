package com.pimote.android.call

import com.pimote.android.net.WsClient
import com.pimote.android.protocol.CallBindCommand
import com.pimote.android.protocol.CallBindErrorCodes
import com.pimote.android.protocol.CallBindResponseData
import com.pimote.android.protocol.CallEndCommand
import com.pimote.android.protocol.CallEndReasonWire
import com.pimote.android.protocol.CallEndedEvent
import com.pimote.android.protocol.CallReadyEvent
import com.pimote.android.protocol.OpenSessionCommand
import com.pimote.android.protocol.OpenSessionResponseData
import com.pimote.android.telephony.CallConnection
import com.pimote.android.voice.PeerConnectionFailed
import com.pimote.android.voice.PeerState
import com.pimote.android.voice.SpeechmuxPeer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * The dialing target for a fresh outgoing call.
 * - [ExistingSession] reuses a known session id.
 * - [NewSessionInProject] opens a new session in the given folder before binding
 *   the call (project hotline pattern).
 */
sealed interface SessionTarget {
    data class ExistingSession(val sessionId: String) : SessionTarget
    data class NewSessionInProject(val folderPath: String) : SessionTarget
}

/**
 * The state machine surfaced by [CallController]. Transitions (in the happy
 * path):
 *
 *     Idle → Dialing → Binding → Negotiating → Active → Ended → Idle
 *
 * Failures collapse to [Ended] from any state. Once [Ended], the controller
 * resets back to [Idle] (state goes back to Idle after the held connection is
 * released) so the next call may begin.
 */
sealed interface CallState {
    object Idle : CallState
    data class Dialing(val target: SessionTarget) : CallState

    /** call_bind has been issued; awaiting response with the signal URL. */
    data class Binding(val sessionId: String) : CallState

    /** Bind succeeded; SpeechmuxPeer is connecting / ICE-negotiating. */
    data class Negotiating(val sessionId: String) : CallState

    /** Both server-side `call_ready` and peer-side ICE are established. */
    data class Active(val sessionId: String) : CallState

    /** Terminal-for-this-call. `sessionId` may be null if bind never succeeded. */
    data class Ended(val sessionId: String?, val reason: CallEndReason) : CallState
}

enum class CallEndReason {
    USER_HANGUP,
    REMOTE_HANGUP,
    DISPLACED,
    SERVER_ENDED,
    PEER_FAILED,
    BIND_FAILED,
}

/**
 * Single orchestrator for the active call. Bridges WS, WebRTC, and the Telecom
 * [CallConnection].
 *
 * Outgoing-call flow (see docs/plans/native-android-client.md §CallController
 * for the reference pseudocode):
 *
 * 1. `startOutgoing(target, connection)` → [CallState.Dialing].
 * 2. Resolve [target] to a `sessionId` — either existing, or via
 *    `wsClient.request(OpenSessionCommand)`. Failure → `connection.markFailed`,
 *    state = `Ended(null, BIND_FAILED)`.
 * 3. `wsClient.request(CallBindCommand(sessionId, force = false))` →
 *    [CallState.Binding]. On `call_bind_failed_owned`, retry once with
 *    `force = true` (single-owner displacement). Other failures →
 *    `connection.markFailed`, `Ended(sessionId, BIND_FAILED)`.
 * 4. `speechmuxPeer.connect(signalUrl, sessionId)` → [CallState.Negotiating].
 *    Suspends until ICE Connected or fails.
 * 5. Await both `call_ready` for `sessionId` AND peer state == Connected →
 *    `connection.markActive()`, `Active(sessionId)`.
 *
 * While `Active`:
 * - server `call_ended { reason }` → `connection.markEndedRemotely(reason)` →
 *   peer.disconnect() → `Ended(sessionId, mapped reason)`.
 * - peer state Failed → best-effort `wsClient.send(CallEndCommand)` →
 *   `connection.markFailed("peer_failed")` → `Ended(sessionId, PEER_FAILED)`.
 * - `endCurrentCall()` (Telecom user hangup) → best-effort
 *   `wsClient.send(CallEndCommand)` → peer.disconnect() →
 *   `Ended(sessionId, USER_HANGUP)`.
 *
 * The controller filters `wsClient.events` by `state.sessionId` — events for
 * stale calls are ignored.
 *
 * If the WS drops during an active call, the call cannot survive. Surfaced as
 * `Ended(_, PEER_FAILED)`; the WS auto-reconnect loop continues independently.
 *
 * Lifetime: long-lived `AppContainer` singleton. State stays at [Idle] between
 * calls; the held [CallConnection] is released on transition into [Ended].
 */
interface CallController {
    val state: StateFlow<CallState>

    /** Begin an outgoing call against [target], using [connection] as the Telecom binding. */
    fun startOutgoing(target: SessionTarget, connection: CallConnection)

    /** Hangup-from-the-app entry point (forwarded by [CallConnection.markFailed] caller path). */
    fun endCurrentCall()

    /** Forward an audio-state change from Telecom into the controller's UI surface. */
    fun onAudioStateChanged(audioState: AudioRouteSnapshot)
}

/**
 * Plain data view of [android.telecom.CallAudioState]. The controller only
 * uses this for UI display — no WebRTC pipeline manipulation on route change.
 */
data class AudioRouteSnapshot(
    val isMuted: Boolean,
    val route: AudioRoute,
    val supportedRoutes: Set<AudioRoute>,
)

enum class AudioRoute { EARPIECE, SPEAKER, BLUETOOTH, WIRED_HEADSET, STREAMING }

/**
 * Production [CallController]. Constructed by `AppContainer` once per process
 * with the long-lived collaborators. Tests construct it with fakes.
 */
class CallControllerImpl(
    private val wsClient: WsClient,
    private val peerFactory: () -> SpeechmuxPeer,
    private val scope: kotlinx.coroutines.CoroutineScope,
) : CallController {
    private val _state = MutableStateFlow<CallState>(CallState.Idle)
    override val state: StateFlow<CallState> = _state.asStateFlow()

    private val _audioRoute = MutableStateFlow<AudioRouteSnapshot?>(null)
    val audioRoute: StateFlow<AudioRouteSnapshot?> = _audioRoute.asStateFlow()

    private var callJob: Job? = null
    private var userHangup: CompletableDeferred<Unit>? = null
    private var currentSessionId: String? = null
    private var currentPeer: SpeechmuxPeer? = null
    private var currentConnection: CallConnection? = null

    init {
        scope.launch(Dispatchers.Unconfined) {
            _state.collect { com.pimote.android.util.L.d("Call", "state -> $it") }
        }
    }

    private fun newId(): String = java.util.UUID.randomUUID().toString()

    override fun startOutgoing(target: SessionTarget, connection: CallConnection) {
        com.pimote.android.util.L.i("Call", "startOutgoing target=$target")
        callJob?.cancel()
        userHangup = CompletableDeferred()
        currentSessionId = null
        currentPeer = null
        currentConnection = connection
        callJob = scope.launch(Dispatchers.Unconfined) {
            runOutgoing(target, connection)
        }
    }

    override fun endCurrentCall() {
        com.pimote.android.util.L.i("Call", "endCurrentCall (state=${_state.value})")
        userHangup?.complete(Unit)
        // Plan §CallController step 6: if state is pre-Active, also cancel callJob and
        // transition to Ended(currentSessionId, USER_HANGUP). The Active branch is handled
        // inside the select-race in runOutgoing via the userHangup deferred above.
        when (_state.value) {
            is CallState.Dialing,
            is CallState.Binding,
            is CallState.Negotiating -> {
                val sid = currentSessionId
                callJob?.cancel()
                callJob = null
                try { currentPeer?.disconnect() } catch (_: Throwable) { }
                _state.value = CallState.Ended(sid, CallEndReason.USER_HANGUP)
            }
            else -> { /* Idle / Active / Ended — handled by select or no-op */ }
        }
    }

    override fun onAudioStateChanged(audioState: AudioRouteSnapshot) {
        _audioRoute.value = audioState
    }

    private suspend fun runOutgoing(target: SessionTarget, connection: CallConnection) {
        _state.value = CallState.Dialing(target)

        // 1) Resolve sessionId.
        val sessionId: String = when (target) {
            is SessionTarget.ExistingSession -> target.sessionId
            is SessionTarget.NewSessionInProject -> {
                val resp = wsClient.request(
                    OpenSessionCommand(id = newId(), folderPath = target.folderPath),
                    OpenSessionResponseData.serializer(),
                )
                if (!resp.success || resp.data == null) {
                    connection.markFailed(resp.error ?: "open_session_failed")
                    _state.value = CallState.Ended(null, CallEndReason.BIND_FAILED)
                    return
                }
                resp.data.sessionId
            }
        }
        currentSessionId = sessionId

        // 2) call_bind, with single retry on `call_bind_failed_owned`.
        _state.value = CallState.Binding(sessionId)
        var bind = wsClient.request(
            CallBindCommand(id = newId(), sessionId = sessionId, force = false),
            CallBindResponseData.serializer(),
        )
        if (!bind.success && bind.error == CallBindErrorCodes.OWNED) {
            bind = wsClient.request(
                CallBindCommand(id = newId(), sessionId = sessionId, force = true),
                CallBindResponseData.serializer(),
            )
        }
        val bindData = bind.data
        if (!bind.success || bindData == null) {
            connection.markFailed(bind.error ?: "call_bind_failed")
            _state.value = CallState.Ended(sessionId, CallEndReason.BIND_FAILED)
            return
        }

        // 3) Peer connect.
        val peer = peerFactory()
        currentPeer = peer
        _state.value = CallState.Negotiating(sessionId)
        try {
            peer.connect(bindData.webrtcSignalUrl, sessionId)
        } catch (_: PeerConnectionFailed) {
            try { wsClient.send(CallEndCommand(id = newId(), sessionId = sessionId)) } catch (_: Throwable) { }
            connection.markFailed("peer_failed")
            _state.value = CallState.Ended(sessionId, CallEndReason.PEER_FAILED)
            return
        }

        // 4) Await call_ready for this session.
        wsClient.events.filterIsInstance<CallReadyEvent>().filter { it.sessionId == sessionId }.first()
        connection.markActive()
        _state.value = CallState.Active(sessionId)

        // 5) Race: server call_ended | peer Failed | user hangup.
        val hangup = userHangup ?: CompletableDeferred<Unit>().also { userHangup = it }
        val outcome: Outcome = coroutineScope {
            val winner = CompletableDeferred<Outcome>()
            val w1 = launch(Dispatchers.Unconfined) {
                val ev = wsClient.events.filterIsInstance<CallEndedEvent>()
                    .filter { it.sessionId == sessionId }.first()
                winner.complete(Outcome.RemoteEnded(mapWireReason(ev.reason)))
            }
            val w2 = launch(Dispatchers.Unconfined) {
                peer.state.first { it is PeerState.Failed }
                winner.complete(Outcome.PeerFailed)
            }
            val w3 = launch(Dispatchers.Unconfined) {
                hangup.await()
                winner.complete(Outcome.UserHangup)
            }
            val r = winner.await()
            w1.cancel(); w2.cancel(); w3.cancel()
            r
        }

        when (outcome) {
            is Outcome.RemoteEnded -> {
                connection.markEndedRemotely(outcome.reason)
                peer.disconnect()
                _state.value = CallState.Ended(sessionId, outcome.reason)
            }
            is Outcome.PeerFailed -> {
                try { wsClient.send(CallEndCommand(id = newId(), sessionId = sessionId)) } catch (_: Throwable) { }
                connection.markFailed("peer_failed")
                _state.value = CallState.Ended(sessionId, CallEndReason.PEER_FAILED)
            }
            is Outcome.UserHangup -> {
                try { wsClient.send(CallEndCommand(id = newId(), sessionId = sessionId)) } catch (_: Throwable) { }
                peer.disconnect()
                _state.value = CallState.Ended(sessionId, CallEndReason.USER_HANGUP)
            }
        }
    }

    private sealed interface Outcome {
        data class RemoteEnded(val reason: CallEndReason) : Outcome
        object PeerFailed : Outcome
        object UserHangup : Outcome
    }

    private fun mapWireReason(w: CallEndReasonWire): CallEndReason = when (w) {
        CallEndReasonWire.USER_HANGUP -> CallEndReason.USER_HANGUP
        CallEndReasonWire.DISPLACED -> CallEndReason.DISPLACED
        CallEndReasonWire.SERVER_ENDED -> CallEndReason.SERVER_ENDED
        CallEndReasonWire.ERROR -> CallEndReason.SERVER_ENDED
    }
}
