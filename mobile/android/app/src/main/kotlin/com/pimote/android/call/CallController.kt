package com.pimote.android.call

import com.pimote.android.net.WsClient
import com.pimote.android.protocol.CallBindCommand
import com.pimote.android.protocol.CallBindErrorCodes
import com.pimote.android.protocol.CallBindResponseData
import com.pimote.android.protocol.CallEndCommand
import com.pimote.android.protocol.CallEndReasonWire
import com.pimote.android.protocol.CallEndedEvent
import com.pimote.android.protocol.OpenSessionCommand
import com.pimote.android.protocol.OpenSessionResponseData
import com.pimote.android.protocol.SessionClosedEvent
import com.pimote.android.protocol.SessionClosedReasonWire
import com.pimote.android.telephony.CallConnection
import com.pimote.android.voice.PeerConnectionFailed
import com.pimote.android.voice.PeerState
import com.pimote.android.voice.SpeechmuxPeer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
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
 *    `wsClient.request(OpenSessionCommand)`. Failure → `connection.disconnectWithError`,
 *    state = `Ended(null, BIND_FAILED)`.
 * 3. `wsClient.request(CallBindCommand(sessionId, force = false))` →
 *    [CallState.Binding]. On `call_bind_failed_owned`, retry once with
 *    `force = true` (single-owner displacement). Other failures →
 *    `connection.disconnectWithError`, `Ended(sessionId, BIND_FAILED)`.
 * 4. `speechmuxPeer.connect(signalUrl, sessionId)` → [CallState.Negotiating].
 *    Suspends until ICE Connected or fails.
 * 5. Await both `call_ready` for `sessionId` AND peer state == Connected →
 *    `connection.reportActive()`, `Active(sessionId)`.
 *
 * While `Active`:
 * - server `call_ended { reason }` → `connection.disconnectAsRemoteEnded(reason)` →
 *   peer.disconnect() → `Ended(sessionId, mapped reason)`.
 * - peer state Failed → best-effort `wsClient.send(CallEndCommand)` →
 *   `connection.disconnectWithError("peer_failed")` → `Ended(sessionId, PEER_FAILED)`.
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

    /**
     * Whether the local mic is currently muted. Reset to `false` on every new
     * outgoing call. UI surfaces (the in-call screen) drive this via
     * [setMicMuted]; the controller forwards the change to the active peer.
     */
    val isMicMuted: StateFlow<Boolean>

    /** Begin an outgoing call against [target], using [connection] as the Telecom binding. */
    fun startOutgoing(target: SessionTarget, connection: CallConnection)

    /** Hangup-from-the-app entry point (forwarded by [CallConnection.disconnectWithError] caller path). */
    fun endCurrentCall()

    /**
     * Mute or unmute the local mic. Updates [isMicMuted] and forwards to the
     * active [SpeechmuxPeer] (which toggles the WebRTC audio track's enabled
     * flag). No-op when there is no active peer.
     */
    fun setMicMuted(muted: Boolean)

    /**
     * Called when the app's task is being removed (user swiped away the app from
     * Recents) or the process is otherwise about to die. Idempotent and safe from
     * any state. Synchronously releases the local mic (disposes the WebRTC audio
     * source/track), tears down the Telecom [CallConnection] so the
     * ConnectionService can be unbound, and resets state to [CallState.Idle].
     *
     * Defensive belt-and-suspenders: even if [endCurrentCall] is reached via the
     * normal Telecom hangup path, this method must remain a no-op when there is
     * no live call.
     */
    fun onAppShutdown()

    /** Forward an audio-state change from Telecom into the controller's UI surface. */
    fun onAudioStateChanged(audioState: AudioRouteSnapshot)

    /**
     * Latest audio route snapshot reported by Telecom, or `null` before the
     * first `onCallAudioStateChanged` callback (i.e. before the Connection is
     * registered with the framework). UI consumers should treat `null` as
     * "don't show route controls yet."
     */
    val audioRoute: StateFlow<AudioRouteSnapshot?>

    /**
     * Request a route change. Forwarded to the active [CallConnection]; the
     * resulting `audioRoute` flow update is driven by Telecom's
     * `onCallAudioStateChanged` callback once the framework accepts. No-op if
     * there is no active connection.
     */
    fun setAudioRoute(route: AudioRoute)

    /**
     * Whether the active call audio is currently routed to the builtin
     * loudspeaker. Driven by [CallAudioRouter] on API 31+, and by
     * Telecom's `audioRoute` snapshot as a fallback on older releases.
     */
    val isSpeakerphoneOn: StateFlow<Boolean>

    /**
     * Toggle the loudspeaker. On API 31+ this is forwarded to
     * [CallAudioRouter.setSpeakerphone] which selects between the builtin
     * speaker and the best available external comm device. On older
     * releases it falls back to [setAudioRoute] with SPEAKER/EARPIECE.
     */
    fun setSpeakerphone(enabled: Boolean)
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
    /**
     * Optional. Present on API 31+ (constructed in AppContainer); null on
     * 26–30 where `AudioManager.setCommunicationDevice` is unavailable and
     * we fall back to the pre-existing Telecom-route behaviour.
     */
    private val audioRouter: CallAudioRouter? = null,
) : CallController {
    private val _state = MutableStateFlow<CallState>(CallState.Idle)
    override val state: StateFlow<CallState> = _state.asStateFlow()

    private val _isMicMuted = MutableStateFlow(false)
    override val isMicMuted: StateFlow<Boolean> = _isMicMuted.asStateFlow()

    private val _audioRoute = MutableStateFlow<AudioRouteSnapshot?>(null)
    override val audioRoute: StateFlow<AudioRouteSnapshot?> = _audioRoute.asStateFlow()

    // Speakerphone state: prefer the router's authoritative flow on 31+,
    // fall back to deriving it from the Telecom audio-route snapshot on
    // older releases.
    private val _legacySpeakerphoneOn = MutableStateFlow(false)
    override val isSpeakerphoneOn: StateFlow<Boolean> =
        audioRouter?.speakerphoneOn ?: _legacySpeakerphoneOn.asStateFlow()

    /**
     * Per-call state, held as an immutable record inside a single
     * [MutableStateFlow]. When the slot is non-null a call is live; when it
     * is null no call is in flight. Every per-call field that the old
     * implementation kept as a separate mutable `var` lives on this record
     * — the call's identity is one value, not six independent fields, so
     * there is no way for them to drift.
     *
     * Transitions during the call (sessionId resolved, peer created) use
     * [MutableStateFlow.update] which is atomic. Terminal transitions use
     * [MutableStateFlow.compareAndSet] so concurrent terminations (e.g.
     * user hangup racing the server's call_ended) cannot both fire the
     * teardown effects — only the swap that wins runs them; the loser is a
     * no-op. The old `finished: Boolean` idempotence flag goes away.
     */
    private data class Live(
        val connection: CallConnection,
        val callJob: Job,
        val userHangup: CompletableDeferred<Unit>,
        val sessionId: String?,
        val peer: SpeechmuxPeer?,
    )

    private val live = MutableStateFlow<Live?>(null)

    init {
        scope.launch(Dispatchers.Unconfined) {
            _state.collect { com.pimote.android.util.L.d("Call", "state -> $it") }
        }
        // Drive the audio router off call-state edges. We start the router
        // when the call leaves Idle and stop it when it returns to Idle/Ended,
        // so the BT SCO link is engaged for the duration of the call and
        // released afterwards (clearing the comm device). On API 26–30 the
        // router is null and this collector is a no-op.
        if (audioRouter != null) {
            scope.launch(Dispatchers.Unconfined) {
                _state
                    .map { s -> s !is CallState.Idle && s !is CallState.Ended }
                    .distinctUntilChanged()
                    .collect { active -> if (active) audioRouter.start() else audioRouter.stop() }
            }
        }
    }

    private fun newId(): String = java.util.UUID.randomUUID().toString()

    override fun startOutgoing(target: SessionTarget, connection: CallConnection) {
        com.pimote.android.util.L.i("Call", "startOutgoing target=$target")
        // Cancel any prior live call's job before installing a fresh slot.
        live.value?.callJob?.cancel()
        // Fresh call starts unmuted.
        _isMicMuted.value = false
        // Clear the previous call's route snapshot; Telecom will re-emit
        // `onCallAudioStateChanged` once this connection is registered.
        _audioRoute.value = null
        val hangup = CompletableDeferred<Unit>()
        // LAZY + explicit start() lets us install the Live slot BEFORE
        // runOutgoing runs its first line. With Dispatchers.Unconfined and
        // an eager start, runOutgoing would race ahead and call live.update
        // before the slot was even populated, dropping the resolved sessionId
        // on the floor.
        val job = scope.launch(Dispatchers.Unconfined, start = CoroutineStart.LAZY) {
            runOutgoing(target, connection)
        }
        live.value = Live(
            connection = connection,
            callJob = job,
            userHangup = hangup,
            sessionId = null,
            peer = null,
        )
        job.start()
    }

    override fun endCurrentCall() {
        com.pimote.android.util.L.i("Call", "endCurrentCall (state=${_state.value})")
        val current = live.value ?: return  // no live call — nothing to end
        // Active: complete the userHangup deferred so runOutgoing's race
        // resolves to UserHangup and calls terminate from there.
        // Pre-Active: there's no race yet; terminate directly.
        when (_state.value) {
            is CallState.Active -> current.userHangup.complete(Unit)
            is CallState.Dialing,
            is CallState.Binding,
            is CallState.Negotiating -> {
                current.userHangup.complete(Unit)
                terminate(CallEndReason.USER_HANGUP)
            }
            else -> { /* Idle / Ended — no-op */ }
        }
    }

    /**
     * Single point of call teardown. Every terminal path — user hangup,
     * remote hangup, peer failure, bind failure, app shutdown — routes
     * through here. Atomic via `live.compareAndSet`: only the caller whose
     * swap wins runs the teardown effects; concurrent callers see `live`
     * already nulled out and return [TerminateResult.AlreadyDone] with no
     * side effects.
     *
     * Order matters: peer.disconnect() must run before the Telecom
     * connection is destroyed, because destroying the Connection flips the
     * system audio mode back to MODE_NORMAL — if AudioRecord is still open
     * at that point the mic indicator stays lit and the mic stays held
     * against other apps.
     *
     * @return [TerminateResult.Performed] with the snapshot the caller's
     *   swap won against, or [TerminateResult.AlreadyDone] if the slot was
     *   already empty / a peer beat this caller to the swap.
     */
    private fun terminate(
        reason: CallEndReason,
        failureReason: String? = null,
        terminalState: CallState? = null,
    ): TerminateResult {
        while (true) {
            val current = live.value ?: return TerminateResult.AlreadyDone
            if (!live.compareAndSet(current, null)) continue  // another caller swapped; retry to observe the new state
            performTermination(current, reason, failureReason, terminalState)
            return TerminateResult.Performed(current)
        }
    }

    private sealed interface TerminateResult {
        object AlreadyDone : TerminateResult
        data class Performed(val snapshot: Live) : TerminateResult
    }

    /**
     * Apply the teardown effects in the order the public contract requires.
     * Pure-of-state w.r.t. the controller: reads only the snapshot handed in,
     * mutates only `_state`. Called exactly once per call (the
     * [terminate] compareAndSet gates entry).
     */
    private fun performTermination(
        snapshot: Live,
        reason: CallEndReason,
        failureReason: String?,
        terminalState: CallState?,
    ) {
        val sessionId = snapshot.sessionId
        // Policy: the server already knows the call is over iff the server
        // told us. For BIND_FAILED there is no bound call to tell about. For
        // user hangup / peer failure we notify so the server can release the
        // binding immediately rather than waiting for signaling timeout.
        val notifyServer = sessionId != null && when (reason) {
            CallEndReason.REMOTE_HANGUP,
            CallEndReason.DISPLACED,
            CallEndReason.SERVER_ENDED,
            CallEndReason.BIND_FAILED -> false
            CallEndReason.USER_HANGUP,
            CallEndReason.PEER_FAILED -> true
        }
        if (notifyServer && sessionId != null) {
            scope.launch {
                try { wsClient.send(CallEndCommand(id = newId(), sessionId = sessionId)) } catch (_: Throwable) { }
            }
        }
        try { snapshot.peer?.disconnect() } catch (_: Throwable) { }
        try {
            when (reason) {
                CallEndReason.USER_HANGUP -> snapshot.connection.disconnectAsLocalHangup()
                CallEndReason.PEER_FAILED -> snapshot.connection.disconnectWithError(failureReason ?: "peer_failed")
                CallEndReason.BIND_FAILED -> snapshot.connection.disconnectWithError(failureReason ?: "bind_failed")
                CallEndReason.REMOTE_HANGUP,
                CallEndReason.DISPLACED,
                CallEndReason.SERVER_ENDED -> snapshot.connection.disconnectAsRemoteEnded(reason)
            }
        } catch (_: Throwable) { }
        _state.value = terminalState ?: CallState.Ended(sessionId, reason)
    }

    override fun onAudioStateChanged(audioState: AudioRouteSnapshot) {
        _audioRoute.value = audioState
        // Legacy fallback only: on API 31+ the router owns this flow.
        if (audioRouter == null) {
            _legacySpeakerphoneOn.value = audioState.route == AudioRoute.SPEAKER
        }
    }

    override fun setAudioRoute(route: AudioRoute) {
        try { live.value?.connection?.setAudioRoute(route) } catch (_: Throwable) { /* best-effort */ }
    }

    override fun setSpeakerphone(enabled: Boolean) {
        if (audioRouter != null) {
            audioRouter.setSpeakerphone(enabled)
        } else {
            // Pre-API-31 fallback: route via Telecom and mirror the request
            // into the legacy state flow. `onAudioStateChanged` will overwrite
            // this with the framework's reported route once Telecom acks.
            _legacySpeakerphoneOn.value = enabled
            setAudioRoute(if (enabled) AudioRoute.SPEAKER else AudioRoute.EARPIECE)
        }
    }

    override fun setMicMuted(muted: Boolean) {
        _isMicMuted.value = muted
        try { live.value?.peer?.setMicMuted(muted) } catch (_: Throwable) { /* idempotent best-effort */ }
    }

    override fun onAppShutdown() {
        com.pimote.android.util.L.i("Call", "onAppShutdown (state=${_state.value})")
        // Route through terminate so the teardown sequence (notify server,
        // release mic, destroy Telecom Connection) lives in exactly one
        // place. App-shutdown differs from a normal user hangup only in two
        // ways, both expressed as parameters here:
        //  - terminalState is Idle, not Ended(...). The process is about to
        //    die; no subscriber will be alive to observe an Ended.
        //  - The DisconnectCause is LOCAL (via USER_HANGUP), not the
        //    misleading ERROR the previous open-coded path used.
        val current = live.value ?: run {
            // No call in flight — just make sure state is Idle and bail.
            _state.value = CallState.Idle
            return
        }
        current.callJob.cancel()
        current.userHangup.complete(Unit)
        terminate(CallEndReason.USER_HANGUP, terminalState = CallState.Idle)
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
                    terminate(CallEndReason.BIND_FAILED, failureReason = resp.error ?: "open_session_failed")
                    return
                }
                resp.data.sessionId
            }
        }
        // Record the resolved sessionId on the live slot. update is atomic;
        // if the slot was already torn down (concurrent user hangup or
        // app shutdown), the lambda's `it` will be null, copy is skipped,
        // and the slot stays null. Subsequent terminate calls become no-ops
        // via compareAndSet, so it is safe to fall through.
        live.update { it?.copy(sessionId = sessionId) }
        if (live.value == null) return

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
            terminate(CallEndReason.BIND_FAILED, failureReason = bind.error ?: "call_bind_failed")
            return
        }

        // 3) Peer connect.
        val peer = peerFactory()
        live.update { it?.copy(peer = peer) }
        if (live.value == null) {
            // Slot was torn down between sessionId and now — dispose the
            // peer we just created and bail.
            try { peer.disconnect() } catch (_: Throwable) { }
            return
        }
        _state.value = CallState.Negotiating(sessionId)
        try {
            peer.connect(bindData.webrtcSignalUrl, sessionId)
        } catch (e: PeerConnectionFailed) {
            com.pimote.android.util.L.w("Call", "peer connect failed: reason=${e.reason} signalUrl=${bindData.webrtcSignalUrl}", e)
            terminate(CallEndReason.PEER_FAILED, failureReason = "peer_failed")
            return
        }

        // 4) Peer is locally connected — that *is* call-ready.
        //
        // The server does not actually emit `call_ready`; the PWA's
        // voice-call-seams synthesizes it via `onPeerReady` once ICE
        // hits `connected`/`completed` (see
        // client/src/lib/stores/voice-call-seams.ts and
        // client/src/lib/stores/voice-call-store.ts `onPeerReady`).
        // Mirror that here — awaiting a real `CallReadyEvent` would hang
        // forever. `peer.connect` only returns once ICE is established,
        // so by the time we get here the peer is ready.
        connection.reportActive()
        _state.value = CallState.Active(sessionId)
        // Re-apply mute state in case the user toggled mute during Negotiating
        // (peer.setMicMuted is a no-op before the audio track exists).
        try { peer.setMicMuted(_isMicMuted.value) } catch (_: Throwable) { }

        // 5) Race: server call_ended | server session_closed(displaced) | peer Failed | user hangup.
        //
        // The `session_closed { reason: 'displaced' }` branch mirrors the
        // PWA's `voice-call-store.ts` shortcut: when another client takes
        // over our session via call_bind(force=true), the server emits
        // `session_closed` rather than `call_ended`. Without this branch
        // the call would sit in Active forever and Telecom would keep the
        // VoIP audio mode on. See docs/plans/android-call-displacement.md.
        val hangup = live.value?.userHangup ?: return  // slot already torn down
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
            val w4 = launch(Dispatchers.Unconfined) {
                wsClient.events.filterIsInstance<SessionClosedEvent>()
                    .filter { it.sessionId == sessionId && it.reason == SessionClosedReasonWire.DISPLACED }
                    .first()
                winner.complete(Outcome.RemoteEnded(CallEndReason.DISPLACED))
            }
            val r = winner.await()
            w1.cancel(); w2.cancel(); w3.cancel(); w4.cancel()
            r
        }

        when (outcome) {
            is Outcome.RemoteEnded -> terminate(outcome.reason)
            is Outcome.PeerFailed -> terminate(CallEndReason.PEER_FAILED, failureReason = "peer_failed")
            is Outcome.UserHangup -> terminate(CallEndReason.USER_HANGUP)
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
