package com.pimote.android.voice

import kotlinx.coroutines.flow.StateFlow

/**
 * Lifecycle states for a single [SpeechmuxPeer]. The peer is one-shot per
 * call: once it reaches [Closed] or [Failed], a fresh peer is created for
 * the next call.
 */
sealed interface PeerState {
    object Idle : PeerState
    object Connecting : PeerState
    object Negotiating : PeerState
    object Connected : PeerState
    data class Failed(val reason: String) : PeerState
    object Closed : PeerState
}

/**
 * Thrown from [SpeechmuxPeer.connect] when the peer fails to reach
 * [PeerState.Connected].
 */
class PeerConnectionFailed(val reason: String) : RuntimeException(reason)

/**
 * WebRTC leg from the Android client to speechmux. Caller is responsible for
 * having `RECORD_AUDIO` granted before calling [connect]; the peer never
 * requests permissions.
 *
 * Signaling: WebSocket to the [signalUrl] returned by `call_bind`. JSON frame
 * vocabulary matches the existing speechmux contract (`session` / SDP
 * offer-answer / ICE candidate). ICE candidates produced locally are buffered
 * until the `session` envelope arrives; TURN credentials from the `session`
 * frame are applied via `setConfiguration`.
 *
 * The peer never tears down on audio-route changes — single continuous mic
 * stream for the call's lifetime.
 */
interface SpeechmuxPeer {
    val state: StateFlow<PeerState>

    /**
     * Connect to [signalUrl] and negotiate the peer for [sessionId]. Suspends
     * until [PeerState.Connected] or throws [PeerConnectionFailed]. Idempotent
     * only in the sense that calling [connect] twice in a row on the same
     * peer instance is a programming error (state must be [PeerState.Idle]).
     */
    suspend fun connect(signalUrl: String, sessionId: String)

    /**
     * Tear down the peer, signaling socket, and mic capture. Idempotent and
     * safe to call from any state. After [disconnect], state is [PeerState.Closed].
     */
    fun disconnect()

    /** Mute or unmute the local mic track. No-op if not yet [PeerState.Connected]. */
    fun setMicMuted(muted: Boolean)
}
