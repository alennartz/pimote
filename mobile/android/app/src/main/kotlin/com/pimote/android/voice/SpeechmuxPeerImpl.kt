package com.pimote.android.voice

import com.pimote.android.BuildConfig
import com.pimote.android.util.L
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
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
import android.media.AudioDeviceInfo
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStatsReport
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.math.BigInteger
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.nio.charset.StandardCharsets
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Production [SpeechmuxPeer] backed by stream-webrtc-android. Each instance
 * is one-shot: construct a new one per call.
 *
 * Ownership: this instance now OWNS the [factory] and [adm] passed to it.
 * AppContainer builds a fresh PeerConnectionFactory + JavaAudioDeviceModule
 * pair per call so that [disconnect] can release the ADM — which in turn
 * fully releases the underlying AudioRecord and clears the system mic
 * privacy indicator. AudioRecord.stop() alone is not enough on Pixel; only
 * AudioDeviceModule.release() actually closes the AudioRecord.
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
    private val adm: org.webrtc.audio.JavaAudioDeviceModule,
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val json: Json = Json { ignoreUnknownKeys = true },
    // The capture device the AudioRecord must follow, decided by
    // CallAudioRouter. Null on API < 31 (no router). When present, we bind the
    // ADM's AudioRecord to each emitted device via setPreferredInputDevice so
    // capture follows the comm-device route (BT SCO earbud mic, Android Auto)
    // instead of being orphaned on whatever device it opened against. Without
    // this the record opens on the builtin mic and goes silent the instant the
    // OS brings up duplex SCO at playback start.
    private val preferredInputDevice: StateFlow<AudioDeviceInfo?>? = null,
) : SpeechmuxPeer {

    private val _state = MutableStateFlow<PeerState>(PeerState.Idle)
    override val state: StateFlow<PeerState> = _state.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    /** Gate so the per-call native teardown runs exactly once even under a
     *  concurrent disconnect() race (terminate vs the connect() error path). (M2) */
    private val closed = AtomicBoolean(false)
    /** Pending grace timer for a transient ICE DISCONNECTED, if any. (M1) */
    private var iceDisconnectGraceJob: Job? = null

    private var peer: PeerConnection? = null
    private var signalingSocket: WebSocket? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var audioSender: org.webrtc.RtpSender? = null

    // ----- Control DataChannel (`speechmux-control`) -----
    // Created locally before `createOffer` so the m=application section is
    // in the SDP. Carries client→server `playhead` (~20 Hz, jitter-buffer
    // emitted-sample count at 48 kHz) plus `turn_ready`, and server→client
    // `interrupt` plus `prepare_turn` frames. Protocol reference:
    // speechmux/docs/webrtc-protocol.md, Phase 3.
    private var controlChannel: DataChannel? = null
    private var playheadJob: Job? = null
    private var audioStatsJob: Job? = null
    private var inboundAudioReceiver: RtpReceiver? = null
    private var lastReportedPlayhead: Long = -1L
    @Volatile private var muteRestoreToken: Long = 0L

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
                            // Recovered (or first connect) — cancel any pending
                            // ICE-disconnect grace timer. (M1)
                            iceDisconnectGraceJob?.cancel()
                            iceDisconnectGraceJob = null
                            _state.value = PeerState.Connected
                            connectedDeferred.complete(Unit)
                        }
                        PeerConnection.IceConnectionState.FAILED -> {
                            iceDisconnectGraceJob?.cancel()
                            iceDisconnectGraceJob = null
                            _state.value = PeerState.Failed("ice_failed")
                            connectedDeferred.completeExceptionally(PeerConnectionFailed("ice_failed"))
                        }
                        PeerConnection.IceConnectionState.DISCONNECTED -> {
                            // DISCONNECTED is usually transient (Wi-Fi↔cellular
                            // handoff, brief RF loss); libwebrtc often recovers to
                            // CONNECTED on its own. Hold the call and only fail if
                            // it hasn't recovered within the grace window. (M1)
                            if (iceDisconnectGraceJob == null) {
                                iceDisconnectGraceJob = scope.launch {
                                    delay(ICE_DISCONNECT_GRACE_MS)
                                    _state.value = PeerState.Failed("ice_disconnected")
                                    connectedDeferred.completeExceptionally(PeerConnectionFailed("ice_disconnected"))
                                }
                            }
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
                override fun onDataChannel(p0: org.webrtc.DataChannel?) {
                    // Speechmux is the answerer and never opens its own DC;
                    // the only channel that should appear here is the one
                    // we created locally, surfaced via the remote leg. Log
                    // and ignore — we already track our own handle.
                    L.d("Peer", "unexpected remote-initiated DataChannel label=${p0?.label()}")
                }
                override fun onRenegotiationNeeded() {}
                override fun onAddTrack(receiver: org.webrtc.RtpReceiver?, streams: Array<out org.webrtc.MediaStream>?) {
                    // Capture the remote audio receiver so `interrupt`
                    // frames can briefly disable inbound playback to mute
                    // the in-flight jitter-buffer tail.
                    if (receiver != null && receiver.track()?.kind() == "audio") {
                        inboundAudioReceiver = receiver
                        L.d("Peer", "captured inbound audio receiver")
                    }
                }
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

            // Make capture follow the comm-device route. CallAudioRouter emits
            // the input device that matches its current communication device;
            // we bind the ADM's AudioRecord to it. setPreferredInputDevice
            // applies to a live, already-started record, so a mid-call route
            // flip (duplex SCO coming up at playback start, an Android Auto
            // hand-off) re-routes capture instead of stranding it on the
            // device the record happened to open against. The collector lives
            // on `scope`, which disconnect() cancels.
            preferredInputDevice?.let { flow ->
                scope.launch {
                    flow.collect { dev ->
                        try {
                            adm.setPreferredInputDevice(dev)
                            L.i("Peer", "setPreferredInputDevice type=${dev?.type} id=${dev?.id}")
                        } catch (t: Throwable) {
                            L.w("Peer", "setPreferredInputDevice threw", t)
                        }
                    }
                }
            }

            // Create the speechmux-control DataChannel BEFORE the offer is
            // built so the m=application section is part of the SDP. If we
            // don't, speechmux degrades to whole-turn walk-back on barge-in
            // (no playhead → heard-samples floors at 0).
            val dcInit = DataChannel.Init().apply {
                ordered = true
                // Reliable defaults: do NOT set maxRetransmits / maxPacketLifeTime.
                negotiated = false
            }
            val ctrl = pc.createDataChannel("speechmux-control", dcInit)
            if (ctrl == null) {
                L.w("Peer", "createDataChannel('speechmux-control') returned null — barge-in walk-back will be coarse")
            } else {
                controlChannel = ctrl
                ctrl.registerObserver(object : DataChannel.Observer {
                    override fun onBufferedAmountChange(p0: Long) {}
                    override fun onStateChange() {
                        val s = ctrl.state()
                        L.i("Peer", "control DC state=$s")
                        if (s == DataChannel.State.OPEN) {
                            startPlayheadReporter()
                            startOutboundAudioReporter()
                        } else if (s == DataChannel.State.CLOSED || s == DataChannel.State.CLOSING) {
                            playheadJob?.cancel()
                            playheadJob = null
                            audioStatsJob?.cancel()
                            audioStatsJob = null
                        }
                    }
                    override fun onMessage(buffer: DataChannel.Buffer?) {
                        val data = buffer?.data ?: return
                        if (buffer.binary) {
                            L.d("Peer", "control DC: ignoring binary frame")
                            return
                        }
                        val bytes = ByteArray(data.remaining()).also { data.get(it) }
                        val text = String(bytes, StandardCharsets.UTF_8)
                        handleControlFrame(text)
                    }
                })
            }

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
            // Bound signaling + ICE negotiation with an overall deadline so a
            // stalled session/answer/ICE can't suspend connect() forever, leaving
            // the call in Negotiating until a manual hangup. (M1)
            withTimeout(NEGOTIATION_TIMEOUT_MS) {
                signalConnected.await()

                _state.value = PeerState.Negotiating

                // We do NOT create or send the offer here. The offer is sent
                // from `applySessionFrame` once speechmux's `session` envelope
                // has delivered the per-call TURN config — otherwise ICE
                // gathering produces only host candidates and connectivity
                // fails on symmetric NATs.
                connectedDeferred.await()
            }
        } catch (e: PeerConnectionFailed) {
            disconnect()
            throw e
        } catch (e: TimeoutCancellationException) {
            // Signaling/ICE didn't complete within the deadline — surface as a
            // peer failure rather than a bare cancellation. (M1)
            disconnect()
            throw PeerConnectionFailed("negotiation_timeout")
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Cooperative cancellation (e.g. the callJob was cancelled) must
            // unwind as cancellation, not be rewritten into PeerConnectionFailed
            // — otherwise the caller takes the error/terminate path. (L3)
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
                logAnswerSdp(sdp)
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
                val candidateElement = env.payload["candidate"]
                if (candidateElement == null || candidateElement == kotlinx.serialization.json.JsonNull) {
                    L.d("Peer", "recv end-of-candidates")
                    return
                }
                val candidate = candidateElement.jsonPrimitive.content
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

    /**
     * Pull the audio m-section direction and a-line summary out of the answer
     * SDP. We need this to confirm both ends agreed on `sendrecv` and to spot
     * cases where speechmux pinned the answer to `recvonly` (which would mean
     * we never get inbound audio regardless of ADM).
     */
    private fun logAnswerSdp(sdp: String) {
        val lines = sdp.split('\n').map { it.trimEnd('\r') }
        var inAudio = false
        var direction: String? = null
        var codecs: String? = null
        for (line in lines) {
            if (line.startsWith("m=audio")) {
                inAudio = true
                codecs = line
                continue
            }
            if (line.startsWith("m=") && !line.startsWith("m=audio")) {
                inAudio = false
            }
            if (inAudio && (line == "a=sendrecv" || line == "a=recvonly" ||
                    line == "a=sendonly" || line == "a=inactive")) {
                direction = line
            }
        }
        L.i("Peer", "answer audio: $codecs direction=$direction sdpLen=${sdp.length}")
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
        // Only the first caller runs teardown. A concurrent second disconnect()
        // (e.g. connect()'s error path racing terminate's snapshot.peer.disconnect())
        // would otherwise double-dispose the native peer/factory/ADM and SIGSEGV
        // — which the try/catch wrappers below cannot catch. (M2)
        if (!closed.compareAndSet(false, true)) return
        // Snapshot and null out fields up-front so a second disconnect() is a no-op.
        val peerToClose = peer
        val sigToClose = signalingSocket
        val trackToDispose = audioTrack
        val srcToDispose = audioSource
        val senderToRemove = audioSender
        val ctrlToClose = controlChannel
        peer = null
        signalingSocket = null
        audioTrack = null
        audioSource = null
        audioSender = null
        controlChannel = null
        inboundAudioReceiver = null
        playheadJob?.cancel()
        playheadJob = null
        audioStatsJob?.cancel()
        audioStatsJob = null
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
            try { ctrlToClose?.unregisterObserver() } catch (_: Throwable) { }
            try { ctrlToClose?.close() } catch (_: Throwable) { }
            try { ctrlToClose?.dispose() } catch (_: Throwable) { }
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
            // Per-call factory + ADM teardown. Order matters: the
            // PeerConnectionFactory holds a raw native pointer to the ADM,
            // so the factory MUST be disposed before adm.release() —
            // otherwise libwebrtc may use-after-free during its own
            // shutdown. After this point AudioRecord is fully released and
            // the system mic privacy indicator clears immediately (vs.
            // staying lit indefinitely with a long-lived ADM, which only
            // calls AudioRecord.stop() in stopRecording).
            try { factory.dispose() } catch (t: Throwable) { L.w("Peer", "factory.dispose threw", t) }
            try { adm.release() } catch (t: Throwable) { L.w("Peer", "adm.release threw", t) }
            L.i("Peer", "disconnect cleanup complete")
        }, "speechmux-peer-cleanup").start()
    }

    override fun setMicMuted(muted: Boolean) {
        audioTrack?.setEnabled(!muted)
    }

    // -------------------------------------------------------------------
    // speechmux-control DataChannel — protocol details in
    // speechmux/docs/webrtc-protocol.md (Phase 3).
    //
    // Note: control-DC frames use a flat envelope `{v, type, ...fields}`,
    // unlike the signaling-WS envelopes which wrap fields in `payload`.
    // -------------------------------------------------------------------

    /**
     * Periodically poll `pc.getStats()` for the inbound-rtp audio stat's
     * `jitterBufferEmittedCount` and forward each new value to speechmux
     * as a `playhead` frame. The 50 ms cadence (~20 Hz) matches the demo
     * client and is the sweet spot for sentence-level walk-back accuracy
     * per the speechmux protocol doc.
     */
    private fun startPlayheadReporter() {
        if (playheadJob?.isActive == true) return
        val pc = peer ?: return
        playheadJob = scope.launch {
            lastReportedPlayhead = -1L
            while (isActive) {
                val pcRef = peer
                val ch = controlChannel
                if (pcRef == null || ch == null || ch.state() != DataChannel.State.OPEN) break
                val emitted = readJitterBufferEmittedCount(pcRef)
                if (emitted != null && emitted != lastReportedPlayhead) {
                    lastReportedPlayhead = emitted
                    val frame = buildJsonObject {
                        put("v", SIGNAL_PROTOCOL_VERSION)
                        put("type", "playhead")
                        put("played_samples_48k", emitted)
                    }.toString()
                    sendControlText(frame)
                }
                delay(50)
            }
        }
    }

    private suspend fun readJitterBufferEmittedCount(pc: PeerConnection): Long? =
        suspendCancellableCoroutine { cont ->
            try {
                pc.getStats { report: RTCStatsReport ->
                    if (cont.isCompleted) return@getStats
                    var best: Long? = null
                    for (stat in report.statsMap.values) {
                        if (stat.type != "inbound-rtp") continue
                        val media = stat.members["mediaType"] as? String ?: stat.members["kind"] as? String
                        if (media != "audio") continue
                        val raw = stat.members["jitterBufferEmittedCount"] ?: continue
                        val v = when (raw) {
                            is BigInteger -> raw.toLong()
                            is Long -> raw
                            is Number -> raw.toLong()
                            else -> continue
                        }
                        // Take the max in case multiple inbound-rtp audio
                        // stats appear (e.g. simulcast); we only have one
                        // inbound audio stream in practice.
                        if (best == null || v > best) best = v
                    }
                    cont.resume(best)
                }
            } catch (t: Throwable) {
                cont.resume(null)
            }
        }

    /**
     * Diagnostic Probe 2 (default off; see `BuildConfig.AUDIO_TELEMETRY`).
     * Every ~1 s, report the captured mic level *after* the local APM but
     * *before* Opus encode (`media-source.audioLevel` / `totalAudioEnergy`)
     * plus cumulative `outbound-rtp` byte/packet counts, over the same
     * speechmux-control channel the playhead uses. The server logs these to
     * `voice_trace`, timeline-aligned with its pre-decode RTP heartbeat, so
     * a mic clamp (level flatlines while AudioRecord is still started) is
     * distinguishable from network loss or a decode problem.
     */
    private fun startOutboundAudioReporter() {
        if (!BuildConfig.AUDIO_TELEMETRY) return
        if (audioStatsJob?.isActive == true) return
        audioStatsJob = scope.launch {
            while (isActive) {
                val pcRef = peer
                val ch = controlChannel
                if (pcRef == null || ch == null || ch.state() != DataChannel.State.OPEN) break
                val stats = readOutboundAudioStats(pcRef)
                if (stats != null) {
                    val frame = buildJsonObject {
                        put("v", SIGNAL_PROTOCOL_VERSION)
                        put("type", "client_audio")
                        put("audio_level", stats.audioLevel)
                        put("total_energy", stats.totalEnergy)
                        put("bytes_sent", stats.bytesSent)
                        put("packets_sent", stats.packetsSent)
                    }.toString()
                    sendControlText(frame)
                    L.i(
                        "Audio",
                        "outbound level=${stats.audioLevel} energy=${stats.totalEnergy} " +
                            "bytesSent=${stats.bytesSent} packetsSent=${stats.packetsSent}",
                    )
                }
                delay(1000)
            }
        }
    }

    private data class OutboundAudioStats(
        val audioLevel: Double,
        val totalEnergy: Double,
        val bytesSent: Long,
        val packetsSent: Long,
    )

    private suspend fun readOutboundAudioStats(pc: PeerConnection): OutboundAudioStats? =
        suspendCancellableCoroutine { cont ->
            try {
                pc.getStats { report: RTCStatsReport ->
                    if (cont.isCompleted) return@getStats
                    var level = 0.0
                    var energy = 0.0
                    var bytes = 0L
                    var packets = 0L
                    for (stat in report.statsMap.values) {
                        val kind = stat.members["kind"] as? String
                            ?: stat.members["mediaType"] as? String
                        when (stat.type) {
                            "media-source" -> {
                                if (kind != "audio") continue
                                (stat.members["audioLevel"] as? Number)?.let { level = it.toDouble() }
                                (stat.members["totalAudioEnergy"] as? Number)?.let {
                                    energy = it.toDouble()
                                }
                            }
                            "outbound-rtp" -> {
                                if (kind != "audio") continue
                                coerceLong(stat.members["bytesSent"])?.let { bytes = it }
                                coerceLong(stat.members["packetsSent"])?.let { packets = it }
                            }
                        }
                    }
                    cont.resume(OutboundAudioStats(level, energy, bytes, packets))
                }
            } catch (t: Throwable) {
                cont.resume(null)
            }
        }

    private fun coerceLong(raw: Any?): Long? = when (raw) {
        is BigInteger -> raw.toLong()
        is Long -> raw
        is Number -> raw.toLong()
        else -> null
    }

    private fun sendControlText(json: String) {
        val ch = controlChannel ?: return
        if (ch.state() != DataChannel.State.OPEN) return
        val bytes = json.toByteArray(StandardCharsets.UTF_8)
        try {
            ch.send(DataChannel.Buffer(ByteBuffer.wrap(bytes), false))
        } catch (t: Throwable) {
            L.w("Peer", "control DC send failed: ${t.message}", t)
        }
    }

    private fun sendTurnReady(requestId: Int, playedSamples48k: Long) {
        val frame = buildJsonObject {
            put("v", SIGNAL_PROTOCOL_VERSION)
            put("type", "turn_ready")
            put("request_id", requestId)
            put("played_samples_48k", playedSamples48k)
        }.toString()
        sendControlText(frame)
    }

    private suspend fun waitForStablePlayhead(): Long {
        var last = readCurrentPlayhead() ?: 0L
        var stableSince = System.currentTimeMillis()
        val deadline = stableSince + 1500L
        while (true) {
            delay(25)
            val next = readCurrentPlayhead() ?: last
            if (next != last) {
                last = next
                stableSince = System.currentTimeMillis()
                continue
            }
            val now = System.currentTimeMillis()
            if (now - stableSince >= 120L || now >= deadline) {
                lastReportedPlayhead = last
                return last
            }
        }
    }

    private suspend fun readCurrentPlayhead(): Long? {
        val pcRef = peer
        if (pcRef == null) return if (lastReportedPlayhead >= 0L) lastReportedPlayhead else null
        return readJitterBufferEmittedCount(pcRef) ?: if (lastReportedPlayhead >= 0L) lastReportedPlayhead else null
    }

    private fun handleControlFrame(text: String) {
        val obj = try {
            json.parseToJsonElement(text).jsonObject
        } catch (_: Throwable) {
            L.w("Peer", "control DC: unparseable frame (len=${text.length})")
            return
        }
        val v = obj["v"]?.jsonPrimitive?.intOrNull
        if (v != SIGNAL_PROTOCOL_VERSION) {
            L.d("Peer", "control DC: ignoring v=$v frame")
            return
        }
        val type = obj["type"]?.jsonPrimitive?.content
        when (type) {
            "interrupt" -> handleInterrupt()
            "prepare_turn" -> {
                val requestId = obj["request_id"]?.jsonPrimitive?.intOrNull
                if (requestId == null) {
                    L.w("Peer", "control DC: prepare_turn missing request_id")
                    return
                }
                scope.launch {
                    val playedSamples = waitForStablePlayhead()
                    sendTurnReady(requestId, playedSamples)
                }
            }
            null -> L.w("Peer", "control DC: missing type")
            else -> L.d("Peer", "control DC: ignoring unknown type=$type")
        }
    }

    /**
     * Silence the inbound jitter-buffer tail for ~120 ms. Speechmux has
     * already stopped sending new audio; this just drops the ~100–200 ms
     * already in flight in our jitter buffer / OS audio pipeline so the
     * user doesn't hear the assistant talking over them.
     */
    private fun handleInterrupt() {
        val track = inboundAudioReceiver?.track() ?: return
        L.i("Peer", "control DC: interrupt — silencing inbound for 120ms")
        val token = ++muteRestoreToken
        try { track.setEnabled(false) } catch (_: Throwable) {}
        scope.launch {
            delay(120)
            // Only restore if no newer interrupt has fired since.
            if (muteRestoreToken == token) {
                try { inboundAudioReceiver?.track()?.setEnabled(true) } catch (_: Throwable) {}
            }
        }
    }

    private companion object {
        /** Wire-protocol version accepted by speechmux `/signal`. */
        const val SIGNAL_PROTOCOL_VERSION = 1
        val EMPTY_PAYLOAD: JsonObject = JsonObject(emptyMap())
        /** Grace period for a transient ICE DISCONNECTED before declaring the
         *  peer failed. (M1) */
        const val ICE_DISCONNECT_GRACE_MS = 5_000L
        /** Overall deadline for signaling + ICE negotiation in connect(). (M1) */
        const val NEGOTIATION_TIMEOUT_MS = 15_000L
    }
}
