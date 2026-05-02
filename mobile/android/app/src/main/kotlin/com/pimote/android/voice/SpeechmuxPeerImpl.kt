package com.pimote.android.voice

import com.pimote.android.util.L
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
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
 * Wire protocol mirrors the PWA's `voice-call-seams.ts`:
 *
 *   - All frames are wrapped in `{v: 1, type, payload}` envelopes.
 *   - On WS open, send `hello` (speechmux runs fail-open behind Cloudflare
 *     Access; no token field needed).
 *   - Speechmux replies with `session` carrying `payload.iceServers`. We
 *     apply those via `pc.setConfiguration` before creating the offer so
 *     ICE gathering uses the per-call TURN credentials.
 *   - We then send `offer { sdp }`, await `answer { sdp }`, and trickle ICE
 *     in both directions as `ice { candidate, sdpMid, sdpMLineIndex }`.
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
    private var audioSender: org.webrtc.RtpSender? = null

    private val pendingLocalCandidates = mutableListOf<IceCandidate>()
    // Inbound ICE candidates received before `setRemoteDescription(answer)`
    // completes. libwebrtc will silently drop addIceCandidate calls made
    // before the remote description is set, which strands the relay
    // candidates and leaves ICE hung in CHECKING. Mirror the PWA's
    // `pendingInboundIce` queue and flush once the remote description is
    // applied. Guarded by [mutex].
    private val pendingInboundCandidates = mutableListOf<IceCandidate>()
    private var sessionFrameApplied = false
    private var offerSent = false
    private var remoteDescriptionSet = false

    // -------------------------------------------------------------------
    // Envelope helpers — mirror client/src/lib/stores/voice-call-seams.ts
    // (`encodeSignal`/`decodeSignal`, `SIGNAL_PROTOCOL_VERSION = 1`).
    // -------------------------------------------------------------------

    private fun encodeEnvelope(type: String, payload: JsonObject = EMPTY_PAYLOAD): String =
        buildJsonObject {
            put("v", SIGNAL_PROTOCOL_VERSION)
            put("type", type)
            put("payload", payload)
        }.toString()

    private data class Envelope(val type: String, val payload: JsonObject)

    private fun decodeEnvelope(text: String): Envelope? {
        val obj = try { json.parseToJsonElement(text).jsonObject } catch (_: Throwable) { return null }
        val v = obj["v"]?.jsonPrimitive?.intOrNull ?: return null
        if (v != SIGNAL_PROTOCOL_VERSION) return null
        val type = obj["type"]?.jsonPrimitive?.content ?: return null
        val payload = (obj["payload"] as? JsonObject) ?: JsonObject(emptyMap())
        return Envelope(type, payload)
    }

    override suspend fun connect(signalUrl: String, sessionId: String) {
        check(_state.value == PeerState.Idle) { "SpeechmuxPeerImpl is one-shot; current state=${_state.value}" }
        L.i("Peer", "connect signalUrl=$signalUrl sessionId=$sessionId")
        _state.value = PeerState.Connecting
        // Pin to Dispatchers.IO so suspendCancellableCoroutine continuations resume on a
        // worker thread rather than libwebrtc's signaling thread. Without this, callers
        // like CallController launching with Dispatchers.Unconfined would resume the
        // continuation on the same thread that fired onCreateSuccess (the signaling
        // thread), and any subsequent peer manipulation on that thread — most notably
        // peer.close() in the disconnect() error path — trips a native CHECK and SIGTRAPs.
        withContext(Dispatchers.IO) {
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
                    L.i("Peer", "iceConnectionState=$s")
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
                override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) {
                    L.i("Peer", "peerConnectionState=$state")
                }
                override fun onIceConnectionReceivingChange(p0: Boolean) {}
                override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
                override fun onIceCandidate(c: IceCandidate?) {
                    if (c == null) {
                        // End-of-candidates. Mirrors the PWA's behaviour
                        // (voice-call-seams.ts) which sends a sentinel
                        // `{candidate:null,sdpMid:'',sdpMLineIndex:0}` so
                        // speechmux knows local gathering is done and can
                        // promote candidate pairs without waiting on the
                        // ICE-candidate-gathering timer. Without this,
                        // ICE completion can be delayed on networks that
                        // gather slowly.
                        scope.launch { mutex.withLock { trickleEndOfCandidates() } }
                        return
                    }
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
            audioSender = pc.addTrack(track, listOf("pimote-stream"))

            // Open signaling.
            val signalConnected = kotlinx.coroutines.CompletableDeferred<Unit>()
            val sigListener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    L.i("Peer", "signaling onOpen")
                    signalConnected.complete(Unit)
                    // `/signal` requires a `hello` envelope before any other
                    // frame. Speechmux's `validate_hello` accepts an empty
                    // payload when running fail-open behind Cloudflare
                    // Access (the auth boundary).
                    try {
                        webSocket.send(encodeEnvelope("hello"))
                    } catch (e: Throwable) {
                        L.w("Peer", "hello send failed: ${e.message}", e)
                    }
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val env = decodeEnvelope(text)
                    if (env == null) {
                        L.w("Peer", "signaling onMessage: unparseable frame (len=${text.length})")
                        return
                    }
                    L.d("Peer", "signaling recv type=${env.type}")
                    scope.launch { handleSignalingFrame(env, pc) }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    L.w("Peer", "signaling onClosed code=$code reason=$reason")
                    val failReason = "signaling_closed:$code"
                    if (_state.value !is PeerState.Closed) {
                        _state.value = PeerState.Failed(failReason)
                    }
                    if (!signalConnected.isCompleted) {
                        signalConnected.completeExceptionally(PeerConnectionFailed(failReason))
                    }
                    if (!connectedDeferred.isCompleted) {
                        connectedDeferred.completeExceptionally(PeerConnectionFailed(failReason))
                    }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    val httpCode = response?.code
                    val httpMsg = response?.message
                    L.w(
                        "Peer",
                        "signaling onFailure throwable=${t::class.java.simpleName} msg=${t.message} " +
                            "httpCode=$httpCode httpMsg=$httpMsg",
                        t,
                    )
                    val reason = t.message ?: "signaling_failed"
                    val reasonWithCode = if (httpCode != null) "$reason (http=$httpCode)" else reason
                    _state.value = PeerState.Failed(reasonWithCode)
                    if (!signalConnected.isCompleted) signalConnected.completeExceptionally(PeerConnectionFailed(reasonWithCode))
                    if (!connectedDeferred.isCompleted) connectedDeferred.completeExceptionally(PeerConnectionFailed(reasonWithCode))
                }
            }
            signalingSocket = httpClient.newWebSocket(
                Request.Builder().url(signalUrl).build(),
                sigListener,
            )
            signalConnected.await()

            _state.value = PeerState.Negotiating

            // We do NOT create or send the offer here. The offer is sent
            // from `applySessionFrame` once speechmux's `session` envelope
            // has delivered the per-call TURN config — otherwise ICE
            // gathering produces only host candidates and connectivity
            // fails on symmetric NATs.
            connectedDeferred.await()
        } catch (e: PeerConnectionFailed) {
            disconnect()
            throw e
        } catch (e: Throwable) {
            disconnect()
            throw PeerConnectionFailed(e.message ?: e::class.java.simpleName)
        }
        }
    }

    private suspend fun handleSignalingFrame(env: Envelope, pc: PeerConnection) {
        when (env.type) {
            "session" -> applySessionFrame(env.payload, pc)
            "answer" -> {
                val sdp = env.payload["sdp"]?.jsonPrimitive?.content ?: return
                setRemoteDescription(pc, SessionDescription(SessionDescription.Type.ANSWER, sdp))
                // Drain any candidates that arrived before the answer was
                // applied. libwebrtc rejects addIceCandidate before SRD,
                // and the relay candidates are exactly the ones we need
                // for connectivity through symmetric NATs / cellular.
                val drained: List<IceCandidate>
                mutex.withLock {
                    remoteDescriptionSet = true
                    drained = pendingInboundCandidates.toList()
                    pendingInboundCandidates.clear()
                }
                if (drained.isNotEmpty()) {
                    L.i("Peer", "flushing ${drained.size} buffered inbound ICE candidates")
                    for (c in drained) {
                        val ok = pc.addIceCandidate(c)
                        if (!ok) L.w("Peer", "addIceCandidate (flush) returned false: mid=${c.sdpMid} mline=${c.sdpMLineIndex}")
                    }
                }
            }
            "ice" -> {
                val candidate = env.payload["candidate"]?.jsonPrimitive?.content ?: return
                val mid = env.payload["sdpMid"]?.jsonPrimitive?.content ?: ""
                val mLine = env.payload["sdpMLineIndex"]?.jsonPrimitive?.intOrNull ?: 0
                val cand = IceCandidate(mid, mLine, candidate)
                val queued: Boolean
                mutex.withLock {
                    if (!remoteDescriptionSet) {
                        pendingInboundCandidates.add(cand)
                        queued = true
                    } else {
                        queued = false
                    }
                }
                if (queued) {
                    L.d("Peer", "queued inbound ICE (pre-SRD): mid=$mid mline=$mLine")
                    return
                }
                val ok = pc.addIceCandidate(cand)
                if (!ok) L.w("Peer", "addIceCandidate returned false: mid=$mid mline=$mLine")
            }
            "error" -> {
                L.w("Peer", "signaling error frame: ${env.payload}")
            }
            "bye" -> {
                L.i("Peer", "signaling bye frame")
            }
        }
    }

    private suspend fun applySessionFrame(payload: JsonObject, pc: PeerConnection) {
        val iceServers = (payload["iceServers"] as? JsonArray)?.mapNotNull { srv ->
            val s = srv as? JsonObject ?: return@mapNotNull null
            val urls: List<String> = when (val u: JsonElement? = s["urls"]) {
                is JsonArray -> u.mapNotNull { it.jsonPrimitive.content }
                is kotlinx.serialization.json.JsonPrimitive -> listOf(u.content)
                else -> return@mapNotNull null
            }
            if (urls.isEmpty()) return@mapNotNull null
            val builder = PeerConnection.IceServer.builder(urls)
            s["username"]?.jsonPrimitive?.content?.let { builder.setUsername(it) }
            s["credential"]?.jsonPrimitive?.content?.let { builder.setPassword(it) }
            builder.createIceServer()
        }.orEmpty()
        if (iceServers.isNotEmpty()) {
            val cfg = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            }
            pc.setConfiguration(cfg)
        }
        L.i("Peer", "applied session frame: iceServers=${iceServers.size}")

        // Now create + send the offer (mirrors PWA: offer is created in the
        // `session` handler so TURN is configured first).
        if (!offerSent) {
            offerSent = true
            val offer = createOffer(pc)
            setLocalDescription(pc, offer)
            signalingSocket?.send(
                encodeEnvelope("offer", buildJsonObject { put("sdp", offer.description) }),
            )
        }

        mutex.withLock {
            sessionFrameApplied = true
            for (c in pendingLocalCandidates) sendCandidate(c)
            pendingLocalCandidates.clear()
        }
    }

    private fun trickle(c: IceCandidate) {
        if (!sessionFrameApplied) {
            pendingLocalCandidates.add(c)
            L.d("Peer", "queued local ICE (pre-session): mid=${c.sdpMid} mline=${c.sdpMLineIndex}")
            return
        }
        sendCandidate(c)
    }

    /**
     * Send the end-of-candidates sentinel. If `session` hasn't arrived yet,
     * queue a marker candidate so it flushes after pending real ones.
     * Marker shape mirrors the PWA's `{candidate:null,sdpMid:'',sdpMLineIndex:0}`.
     */
    private fun trickleEndOfCandidates() {
        if (!sessionFrameApplied) {
            // Defer until session arrives; we use a poison-pill IceCandidate
            // with empty sdp — sendCandidate will translate it back into the
            // null-candidate sentinel when flushing.
            pendingLocalCandidates.add(IceCandidate("", 0, ""))
            L.d("Peer", "queued end-of-candidates sentinel (pre-session)")
            return
        }
        sendEndOfCandidates()
    }

    private fun sendEndOfCandidates() {
        L.d("Peer", "send end-of-candidates")
        signalingSocket?.send(
            encodeEnvelope(
                "ice",
                buildJsonObject {
                    put("candidate", kotlinx.serialization.json.JsonNull)
                    put("sdpMid", "")
                    put("sdpMLineIndex", 0)
                },
            ),
        )
    }

    private fun sendCandidate(c: IceCandidate) {
        // Detect the end-of-candidates poison pill we queued in
        // trickleEndOfCandidates() (empty sdp + empty sdpMid) and translate
        // it into the null-candidate sentinel speechmux expects.
        if (c.sdp.isNullOrEmpty()) {
            sendEndOfCandidates()
            return
        }
        L.d("Peer", "send ICE: mid=${c.sdpMid} mline=${c.sdpMLineIndex}")
        signalingSocket?.send(
            encodeEnvelope(
                "ice",
                buildJsonObject {
                    put("candidate", c.sdp)
                    put("sdpMid", c.sdpMid ?: "")
                    put("sdpMLineIndex", c.sdpMLineIndex)
                },
            ),
        )
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
        // Snapshot and null out fields up-front so a second disconnect() is a no-op.
        val peerToClose = peer
        val sigToClose = signalingSocket
        val trackToDispose = audioTrack
        val srcToDispose = audioSource
        val senderToRemove = audioSender
        peer = null
        signalingSocket = null
        audioTrack = null
        audioSource = null
        audioSender = null
        _state.value = PeerState.Closed
        scope.cancel()
        // libwebrtc forbids peer.close() being called re-entrantly from within an active
        // signaling-thread callback (it CHECKs and SIGTRAPs). Defer native cleanup to a
        // dedicated worker thread so disconnect() is safe from any caller, including
        // mid-callback contexts where suspendCancellableCoroutine resumed on the
        // signaling thread despite our withContext wrapper.
        Thread({
            // Order mirrors the PWA's voice-call.svelte.ts `teardown()`:
            // stop the local microphone FIRST so AudioRecord is released
            // even if the subsequent peer.close() / signaling close throws.
            // libwebrtc-android keeps the JavaAudioDeviceModule's mic open
            // until every AudioSource that referenced it is disposed; the
            // process-singleton PeerConnectionFactory in AppContainer means
            // we MUST explicitly dispose source + track before closing the
            // peer, otherwise the system mic indicator stays lit between
            // calls.
            //
            //   1. Disable the track so no new frames pump into the sender.
            //   2. removeTrack(sender) so the peer drops its reference.
            //   3. Dispose track, then source — source.dispose() is what
            //      actually rings the ADM's stopRecording() bell.
            //   4. Send `bye` and close signaling.
            //   5. Finally close the peer.
            try { trackToDispose?.setEnabled(false) } catch (_: Throwable) { }
            try {
                if (peerToClose != null && senderToRemove != null) {
                    peerToClose.removeTrack(senderToRemove)
                }
            } catch (_: Throwable) { }
            try { trackToDispose?.dispose() } catch (_: Throwable) { }
            try { srcToDispose?.dispose() } catch (_: Throwable) { }
            try {
                if (sigToClose != null) {
                    // Best-effort `bye` so speechmux can tear down cleanly.
                    try { sigToClose.send(encodeEnvelope("bye")) } catch (_: Throwable) { }
                    sigToClose.close(1000, "client closed")
                }
            } catch (_: Throwable) { }
            try { peerToClose?.close() } catch (_: Throwable) { }
            L.i("Peer", "disconnect cleanup complete")
        }, "speechmux-peer-cleanup").start()
    }

    override fun setMicMuted(muted: Boolean) {
        audioTrack?.setEnabled(!muted)
    }

    private companion object {
        /** Wire-protocol version accepted by speechmux `/signal`. */
        const val SIGNAL_PROTOCOL_VERSION = 1
        val EMPTY_PAYLOAD: JsonObject = JsonObject(emptyMap())
    }
}
