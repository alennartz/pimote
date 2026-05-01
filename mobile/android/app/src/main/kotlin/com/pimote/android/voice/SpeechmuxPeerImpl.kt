package com.pimote.android.voice

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Production [SpeechmuxPeer] backed by stream-webrtc-android. Each instance
 * is one-shot: construct a new one per call.
 *
 * The [factory] is a process-wide singleton hoisted into [com.pimote.android.app.AppContainer]
 * — `PeerConnectionFactory` and its companion `EglBase` allocate non-trivial
 * native state and must NOT be created (or disposed) per-call. This instance
 * therefore does not own them; [disconnect] only releases per-call resources
 * (peer, signaling socket, audio source/track).
 *
 * Risk flag: architecture risk #2 (OEM Bluetooth route quirks) and risk #3
 * (speechmux `/signal` accepting plain requests) interact here. If signaling
 * auth turns out to require a cookie/header, this is the file that grows.
 */
class SpeechmuxPeerImpl(
    private val factory: PeerConnectionFactory,
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val json: Json = Json { ignoreUnknownKeys = true },
) : SpeechmuxPeer {

    private val _state = MutableStateFlow<PeerState>(PeerState.Idle)
    override val state: StateFlow<PeerState> = _state.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()

    private var peer: PeerConnection? = null
    private var signalingSocket: WebSocket? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null

    private val pendingLocalCandidates = mutableListOf<IceCandidate>()
    private var sessionFrameApplied = false

    override suspend fun connect(signalUrl: String, sessionId: String) {
        check(_state.value == PeerState.Idle) { "SpeechmuxPeerImpl is one-shot; current state=${_state.value}" }
        _state.value = PeerState.Connecting
        try {
            val connectedDeferred = kotlinx.coroutines.CompletableDeferred<Unit>()
            val rtcConfig = PeerConnection.RTCConfiguration(emptyList()).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            }
            val observer = object : PeerConnection.Observer {
                override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
                override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) {
                    when (s) {
                        PeerConnection.IceConnectionState.CONNECTED,
                        PeerConnection.IceConnectionState.COMPLETED -> {
                            _state.value = PeerState.Connected
                            connectedDeferred.complete(Unit)
                        }
                        PeerConnection.IceConnectionState.FAILED -> {
                            _state.value = PeerState.Failed("ice_failed")
                            connectedDeferred.completeExceptionally(PeerConnectionFailed("ice_failed"))
                        }
                        PeerConnection.IceConnectionState.DISCONNECTED -> {
                            _state.value = PeerState.Failed("ice_disconnected")
                        }
                        else -> { /* ignore */ }
                    }
                }
                override fun onIceConnectionReceivingChange(p0: Boolean) {}
                override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
                override fun onIceCandidate(c: IceCandidate?) {
                    if (c == null) return
                    scope.launch { mutex.withLock { trickle(c) } }
                }
                override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
                override fun onAddStream(p0: org.webrtc.MediaStream?) {}
                override fun onRemoveStream(p0: org.webrtc.MediaStream?) {}
                override fun onDataChannel(p0: org.webrtc.DataChannel?) {}
                override fun onRenegotiationNeeded() {}
                override fun onAddTrack(p0: org.webrtc.RtpReceiver?, p1: Array<out org.webrtc.MediaStream>?) {}
            }
            val pc = factory.createPeerConnection(rtcConfig, observer)
                ?: throw PeerConnectionFailed("createPeerConnection_returned_null")
            peer = pc

            // Local audio track.
            val audioConstraints = MediaConstraints()
            val src = factory.createAudioSource(audioConstraints)
            val track = factory.createAudioTrack("pimote-audio", src)
            audioSource = src
            audioTrack = track
            pc.addTrack(track, listOf("pimote-stream"))

            // Open signaling.
            val signalConnected = kotlinx.coroutines.CompletableDeferred<Unit>()
            val sigListener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    signalConnected.complete(Unit)
                    // Initial handshake — send session id to the speechmux relay.
                    webSocket.send(buildJsonObject {
                        put("type", "session")
                        put("sessionId", sessionId)
                    }.toString())
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    scope.launch { handleSignalingMessage(text, pc) }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (_state.value !is PeerState.Closed) {
                        _state.value = PeerState.Failed("signaling_closed:$code")
                    }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    val reason = t.message ?: "signaling_failed"
                    _state.value = PeerState.Failed(reason)
                    if (!signalConnected.isCompleted) signalConnected.completeExceptionally(PeerConnectionFailed(reason))
                    if (!connectedDeferred.isCompleted) connectedDeferred.completeExceptionally(PeerConnectionFailed(reason))
                }
            }
            signalingSocket = httpClient.newWebSocket(
                Request.Builder().url(signalUrl).build(),
                sigListener,
            )
            signalConnected.await()

            _state.value = PeerState.Negotiating

            // Create offer.
            val offer = createOffer(pc)
            setLocalDescription(pc, offer)
            signalingSocket?.send(buildJsonObject {
                put("type", "offer")
                put("sdp", offer.description)
            }.toString())

            connectedDeferred.await()
        } catch (e: PeerConnectionFailed) {
            disconnect()
            throw e
        } catch (e: Throwable) {
            disconnect()
            throw PeerConnectionFailed(e.message ?: e::class.java.simpleName)
        }
    }

    private suspend fun handleSignalingMessage(text: String, pc: PeerConnection) {
        val obj = try { json.parseToJsonElement(text).jsonObject } catch (_: Throwable) { return }
        when (obj["type"]?.jsonPrimitive?.content) {
            "session" -> applySessionFrame(obj, pc)
            "answer" -> {
                val sdp = obj["sdp"]?.jsonPrimitive?.content ?: return
                setRemoteDescription(pc, SessionDescription(SessionDescription.Type.ANSWER, sdp))
            }
            "ice" -> {
                val cand = obj["candidate"]?.jsonObject ?: return
                val sdp = cand["candidate"]?.jsonPrimitive?.content ?: return
                val mid = cand["sdpMid"]?.jsonPrimitive?.content ?: ""
                val mLine = cand["sdpMLineIndex"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0
                pc.addIceCandidate(IceCandidate(mid, mLine, sdp))
            }
        }
    }

    private suspend fun applySessionFrame(obj: JsonObject, pc: PeerConnection) {
        val iceServers = obj["iceServers"]?.jsonArray?.mapNotNull { srv ->
            val s = srv.jsonObject
            val urls = s["urls"]?.let { u ->
                if (u is kotlinx.serialization.json.JsonArray) u.map { it.jsonPrimitive.content }
                else listOf(u.jsonPrimitive.content)
            } ?: return@mapNotNull null
            val builder = PeerConnection.IceServer.builder(urls)
            s["username"]?.jsonPrimitive?.content?.let { builder.setUsername(it) }
            s["credential"]?.jsonPrimitive?.content?.let { builder.setPassword(it) }
            builder.createIceServer()
        }.orEmpty()
        val cfg = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
        pc.setConfiguration(cfg)
        mutex.withLock {
            sessionFrameApplied = true
            for (c in pendingLocalCandidates) sendCandidate(c)
            pendingLocalCandidates.clear()
        }
    }

    private fun trickle(c: IceCandidate) {
        if (!sessionFrameApplied) {
            pendingLocalCandidates.add(c)
            return
        }
        sendCandidate(c)
    }

    private fun sendCandidate(c: IceCandidate) {
        signalingSocket?.send(buildJsonObject {
            put("type", "ice")
            put("candidate", buildJsonObject {
                put("candidate", c.sdp)
                put("sdpMid", c.sdpMid ?: "")
                put("sdpMLineIndex", c.sdpMLineIndex.toString())
            })
        }.toString())
    }

    private suspend fun createOffer(pc: PeerConnection): SessionDescription =
        suspendCancellableCoroutine { cont ->
            pc.createOffer(object : SdpObserver {
                override fun onCreateSuccess(d: SessionDescription) { cont.resume(d) }
                override fun onCreateFailure(e: String?) { cont.resumeWithException(PeerConnectionFailed(e ?: "create_offer_failed")) }
                override fun onSetSuccess() {}
                override fun onSetFailure(e: String?) {}
            }, MediaConstraints())
        }

    private suspend fun setLocalDescription(pc: PeerConnection, sd: SessionDescription) =
        suspendCancellableCoroutine<Unit> { cont ->
            pc.setLocalDescription(object : SdpObserver {
                override fun onCreateSuccess(d: SessionDescription?) {}
                override fun onCreateFailure(e: String?) {}
                override fun onSetSuccess() { cont.resume(Unit) }
                override fun onSetFailure(e: String?) { cont.resumeWithException(PeerConnectionFailed(e ?: "set_local_failed")) }
            }, sd)
        }

    private suspend fun setRemoteDescription(pc: PeerConnection, sd: SessionDescription) =
        suspendCancellableCoroutine<Unit> { cont ->
            pc.setRemoteDescription(object : SdpObserver {
                override fun onCreateSuccess(d: SessionDescription?) {}
                override fun onCreateFailure(e: String?) {}
                override fun onSetSuccess() { cont.resume(Unit) }
                override fun onSetFailure(e: String?) { cont.resumeWithException(PeerConnectionFailed(e ?: "set_remote_failed")) }
            }, sd)
        }

    override fun disconnect() {
        try { signalingSocket?.close(1000, "client closed") } catch (_: Throwable) { }
        signalingSocket = null
        try { peer?.close() } catch (_: Throwable) { }
        peer = null
        try { audioTrack?.dispose() } catch (_: Throwable) { }
        audioTrack = null
        try { audioSource?.dispose() } catch (_: Throwable) { }
        audioSource = null
        scope.cancel()
        _state.value = PeerState.Closed
    }

    override fun setMicMuted(muted: Boolean) {
        audioTrack?.setEnabled(!muted)
    }
}
