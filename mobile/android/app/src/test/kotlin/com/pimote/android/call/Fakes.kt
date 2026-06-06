package com.pimote.android.call

import com.pimote.android.net.TypedResponse
import com.pimote.android.net.WsClient
import com.pimote.android.net.WsState
import com.pimote.android.protocol.PimoteCommand
import com.pimote.android.protocol.PimoteEvent
import com.pimote.android.telephony.CallConnection
import com.pimote.android.voice.PeerConnectionFailed
import com.pimote.android.voice.PeerState
import com.pimote.android.voice.SpeechmuxPeer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.KSerializer

/**
 * Test fakes for [CallControllerImpl]. Hand-rolled rather than mocked because
 * the controller uses suspended request/response and StateFlow observation
 * patterns that hand-rolled fakes express more clearly than MockK answers.
 */

class FakeWsClient : WsClient {
    override val state = MutableStateFlow<WsState>(WsState.Connected)
    override val lastFailure = MutableStateFlow<String?>(null)

    private val _events = MutableSharedFlow<PimoteEvent>(extraBufferCapacity = 32)
    override val events: SharedFlow<PimoteEvent> = _events

    /** Every command the controller sent (request + send), in order. */
    val sent = mutableListOf<PimoteCommand>()

    /**
     * Pending request continuations keyed by the position they appeared in
     * [sent]. Tests pop these and complete them with a scripted response.
     */
    private val pending = ArrayDeque<CompletableDeferred<TypedResponse<*>>>()

    @Suppress("UNCHECKED_CAST")
    override suspend fun <T> request(
        command: PimoteCommand,
        responseSerializer: KSerializer<T>,
        timeoutMillis: Long,
    ): TypedResponse<T> {
        sent.add(command)
        val def = CompletableDeferred<TypedResponse<*>>()
        pending.addLast(def)
        return def.await() as TypedResponse<T>
    }

    override suspend fun send(command: PimoteCommand) {
        sent.add(command)
    }

    override fun connect(pimoteOrigin: String) {}
    override fun disconnect() {}

    /** Test helper: respond to the next outstanding request. */
    fun <T> respondNext(response: TypedResponse<T>) {
        val d = pending.removeFirst()
        @Suppress("UNCHECKED_CAST")
        (d as CompletableDeferred<TypedResponse<*>>).complete(response)
    }

    /** Test helper: emit a PimoteEvent on the firehose. */
    suspend fun emit(event: PimoteEvent) {
        _events.emit(event)
    }
}

class FakeSpeechmuxPeer : SpeechmuxPeer {
    override val state = MutableStateFlow<PeerState>(PeerState.Idle)

    val connectCalls = mutableListOf<Pair<String, String>>()
    var disconnected = false
    var muted: Boolean? = null

    /** Set non-null to make connect() throw. */
    var connectFailure: PeerConnectionFailed? = null

    override suspend fun connect(signalUrl: String, sessionId: String) {
        connectCalls.add(signalUrl to sessionId)
        connectFailure?.let { throw it }
        state.value = PeerState.Connecting
        state.value = PeerState.Negotiating
        state.value = PeerState.Connected
    }

    override fun disconnect() {
        disconnected = true
        state.value = PeerState.Closed
    }

    override fun setMicMuted(muted: Boolean) {
        this.muted = muted
    }
}

class FakeCallConnection : CallConnection {
    val transitions = mutableListOf<String>()
    val routeRequests = mutableListOf<AudioRoute>()

    override fun reportRinging() {
        transitions.add("ringing")
    }

    override fun reportActive() {
        transitions.add("active")
    }

    override fun disconnectWithError(reason: String) {
        transitions.add("disconnectWithError:$reason")
    }

    override fun disconnectAsRemoteEnded(reason: CallEndReason) {
        transitions.add("disconnectAsRemoteEnded:$reason")
    }

    override fun disconnectAsLocalHangup() {
        transitions.add("disconnectAsLocalHangup")
    }

    override fun setAudioRoute(route: AudioRoute) {
        routeRequests.add(route)
    }
}
