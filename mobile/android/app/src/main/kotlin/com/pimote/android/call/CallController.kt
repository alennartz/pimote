package com.pimote.android.call

import com.pimote.android.telephony.CallConnection
import kotlinx.coroutines.flow.StateFlow

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
    private val wsClient: com.pimote.android.net.WsClient,
    private val peerFactory: () -> com.pimote.android.voice.SpeechmuxPeer,
    private val scope: kotlinx.coroutines.CoroutineScope,
) : CallController {
    override val state: kotlinx.coroutines.flow.StateFlow<CallState>
        get() = TODO("not implemented")

    override fun startOutgoing(target: SessionTarget, connection: com.pimote.android.telephony.CallConnection): Unit =
        TODO("not implemented")

    override fun endCurrentCall(): Unit = TODO("not implemented")

    override fun onAudioStateChanged(audioState: AudioRouteSnapshot): Unit = TODO("not implemented")
}
