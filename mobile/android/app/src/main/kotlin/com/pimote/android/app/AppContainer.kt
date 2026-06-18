package com.pimote.android.app

import android.content.ComponentName
import android.content.Context
import android.os.Build
import com.pimote.android.call.CallAudioRouter
import com.pimote.android.call.CallController
import com.pimote.android.call.CallControllerImpl
import com.pimote.android.call.CallForegroundService
import com.pimote.android.call.CallState
import com.pimote.android.call.ProximityScreenLock
import com.pimote.android.call.shouldHoldProximityLock
import com.pimote.android.net.AccessAuthInterceptor
import com.pimote.android.net.AndroidNetworkAvailabilityMonitor
import com.pimote.android.net.OkHttpWsTransport
import com.pimote.android.net.WsClient
import com.pimote.android.net.WsClientImpl
import okhttp3.OkHttpClient
import com.pimote.android.session.SessionRepository
import com.pimote.android.session.SessionRepositoryImpl
import com.pimote.android.util.onEdge
import kotlinx.coroutines.flow.map
import com.pimote.android.settings.Settings
import com.pimote.android.settings.SettingsImpl
import com.pimote.android.contacts.ContactSyncRunner
import com.pimote.android.shortcuts.AndroidShortcutManagerFacade
import com.pimote.android.shortcuts.ShortcutManagerFacade
import com.pimote.android.shortcuts.ShortcutsRunner
import com.pimote.android.telephony.AndroidTelecomFacade
import com.pimote.android.telephony.PhoneAccountRegistrar
import com.pimote.android.telephony.PhoneAccountRegistrarImpl
import com.pimote.android.telephony.PimoteConnectionService
import com.pimote.android.voice.SpeechmuxPeer
import com.pimote.android.voice.SpeechmuxPeerImpl
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import com.pimote.android.util.L
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Manual-DI container. Constructed once in [PimoteApp.onCreate] and made
 * accessible via [Context.pimoteContainer] for framework-instantiated callers
 * (the Telecom [PimoteConnectionService]) that cannot receive constructor
 * injection.
 */
class AppContainer(private val appContext: Context) {
    val applicationScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val settings: Settings = SettingsImpl(appContext, applicationScope)

    /**
     * Process-wide OkHttp client. The [AccessAuthInterceptor] reads the
     * current Cloudflare Access service-token credentials from [settings]
     * on every request, so the same client is safe to reuse across the
     * WebSocket transport, the speechmux signaling socket, and any future
     * REST callers — credential changes take effect on the next request
     * without reconstructing the client.
     */
    val httpClient: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(AccessAuthInterceptor(settings.current))
        .build()

    val wsClient: WsClient = WsClientImpl(
        transport = OkHttpWsTransport(httpClient),
        networkMonitor = AndroidNetworkAvailabilityMonitor(appContext),
        scope = applicationScope,
    )

    val sessionRepository: SessionRepository = SessionRepositoryImpl(wsClient, applicationScope)

    private val componentName = ComponentName(appContext, PimoteConnectionService::class.java)
    val telecomFacade = AndroidTelecomFacade(appContext, componentName)

    // DR-019: a single Pimote service PhoneAccount instead of per-session/project.
    // Sessions/projects show up as system contacts via [ContactSyncRunner].
    val phoneAccountRegistrar: PhoneAccountRegistrar = PhoneAccountRegistrarImpl(telecomFacade)
    val contactSyncRunner: ContactSyncRunner =
        ContactSyncRunner(appContext, sessionRepository, applicationScope)

    val shortcutManagerFacade: ShortcutManagerFacade =
        AndroidShortcutManagerFacade(appContext)
    val shortcutsRunner: ShortcutsRunner =
        ShortcutsRunner(appContext, sessionRepository, shortcutManagerFacade, applicationScope)

    // EglBase is process-singleton — GL context allocation is expensive and
    // the underlying EGL context is reusable across PeerConnectionFactories.
    // Disposed only on process shutdown (no explicit teardown in v1).
    private val eglBase: EglBase by lazy { EglBase.create() }

    // PeerConnectionFactory.initialize is idempotent-by-design — it sets up
    // libwebrtc's static native state. We do it once on first access and
    // never again. The actual PeerConnectionFactory + ADM, however, are now
    // built fresh per call (see [peerFactory] below) so we can release the
    // ADM after each call. Without per-call ADM release, JavaAudioDeviceModule
    // keeps the underlying AudioRecord allocated even after AudioRecord.stop(),
    // and Pixel's privacy mic indicator stays lit until release() is called.
    private val webrtcInitialized: Unit by lazy {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext)
                .createInitializationOptions(),
        )
        try {
            L.i(
                "Audio",
                "hwAec.platformAvailable=${android.media.audiofx.AcousticEchoCanceler.isAvailable()} " +
                    "hwNs.platformAvailable=${android.media.audiofx.NoiseSuppressor.isAvailable()} " +
                    "hwAgc.platformAvailable=${android.media.audiofx.AutomaticGainControl.isAvailable()}",
            )
        } catch (t: Throwable) {
            L.w("Audio", "audiofx availability probe threw", t)
        }
    }
    // Explicit JavaAudioDeviceModule. Without it, libwebrtc falls back to its
    // C++ default ADM (OpenSL ES) whose output stream type does not align with
    // the MODE_IN_COMMUNICATION audio mode Telecom puts the system into for
    // self-managed VoIP calls. JavaAudioDeviceModule uses
    // AudioAttributes.USAGE_VOICE_COMMUNICATION + CONTENT_TYPE_SPEECH for
    // playback and AudioRecord with VOICE_COMMUNICATION input — both aligned
    // with the call audio path the OS expects for VoIP.
    //
    // Audio source is VOICE_RECOGNITION. VOICE_COMMUNICATION (the JavaADM
    // default) routes capture through Pixel/Tensor's FORTEMEDIA "AMixMODEM"
    // telephony DSP in MODE_IN_COMMUNICATION, which zeroes the uplink gain a
    // few seconds into a call (kernel: `[AMixMODEM] pGainUL_: 0`; server
    // traces: phone capture at digital silence RMS ~3e-6 for 40+s mid-call).
    // VOICE_RECOGNITION keeps that chain out of our AudioSession; libwebrtc's
    // software AEC3 + NS3 own echo/noise/AGC entirely in user space. This is
    // the workaround used by Linphone / Jami / Briar on Pixel.
    //
    // We deliberately run a SINGLE processing stack (software APM on a
    // raw-ish source), not two: stacking the platform comms DSP on top of
    // libwebrtc's APM let two AGC/AEC chains fight and clamp the mic. Output
    // routing (BT HFP/SCO, Android Auto) is owned by `CallAudioRouter` via
    // `AudioManager.setCommunicationDevice` on API 31+. That selection routes
    // *output* only; the capture AudioRecord does not follow it on its own and
    // with VOICE_RECOGNITION would strand on the builtin mic, going silent the
    // instant duplex SCO comes up at playback start. `CallAudioRouter` also
    // publishes the matching capture device (`preferredInputDevice`), which
    // SpeechmuxPeerImpl binds to the ADM's AudioRecord via
    // `setPreferredInputDevice` so the mic follows the route (BT SCO/BLE
    // earbud mic, AA car mic) live, including the mid-call flip.
    //
    // HW AEC + HW NS remain disabled — WebRTC's software AEC3 + NS3 in the
    // APM run by default (createAudioSource constraints) and handle echo /
    // noise / AGC entirely in user space.
    //
    // Lifecycle: the ADM is process-singleton, paired with the factory. It is
    // never explicitly released in v1 — the OS reclaims on process death.
    // Per-call mic lifecycle is handled by ref-counting against AudioSource:
    // SpeechmuxPeerImpl.disconnect disposes the source, which drops the ADM's
    // recording ref count and stops AudioRecord (clearing the mic indicator).
    /**
     * Build a fresh PeerConnectionFactory + JavaAudioDeviceModule pair. The
     * caller (SpeechmuxPeerImpl) owns both and must dispose the factory and
     * release the ADM in [SpeechmuxPeer.disconnect].
     */
    private fun newPeerConnectionFactoryAndAdm(): Pair<PeerConnectionFactory, org.webrtc.audio.JavaAudioDeviceModule> {
        webrtcInitialized
        val adm = JavaAudioDeviceModule.builder(appContext)
            .setAudioSource(android.media.MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setAudioRecordStateCallback(object : org.webrtc.audio.JavaAudioDeviceModule.AudioRecordStateCallback {
                override fun onWebRtcAudioRecordStart() {
                    val am = appContext.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
                    L.i(
                        "Audio",
                        "AudioRecord START audioMode=${audioModeName(am.mode)} " +
                            "speakerOn=${am.isSpeakerphoneOn} bt=${am.isBluetoothScoOn} " +
                            "micMute=${am.isMicrophoneMute}",
                    )
                }
                override fun onWebRtcAudioRecordStop() { L.i("Audio", "AudioRecord STOP") }
            })
            .setAudioRecordErrorCallback(object : org.webrtc.audio.JavaAudioDeviceModule.AudioRecordErrorCallback {
                override fun onWebRtcAudioRecordInitError(msg: String) { L.w("Audio", "AudioRecord initError: $msg") }
                override fun onWebRtcAudioRecordStartError(
                    code: org.webrtc.audio.JavaAudioDeviceModule.AudioRecordStartErrorCode,
                    msg: String,
                ) { L.w("Audio", "AudioRecord startError: code=$code msg=$msg") }
                override fun onWebRtcAudioRecordError(msg: String) { L.w("Audio", "AudioRecord error: $msg") }
            })
            .setAudioTrackStateCallback(object : org.webrtc.audio.JavaAudioDeviceModule.AudioTrackStateCallback {
                override fun onWebRtcAudioTrackStart() {
                    val am = appContext.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
                    L.i(
                        "Audio",
                        "AudioTrack START audioMode=${audioModeName(am.mode)} " +
                            "speakerOn=${am.isSpeakerphoneOn} bt=${am.isBluetoothScoOn} " +
                            "voiceCallVol=${am.getStreamVolume(android.media.AudioManager.STREAM_VOICE_CALL)}/" +
                            "${am.getStreamMaxVolume(android.media.AudioManager.STREAM_VOICE_CALL)}",
                    )
                }
                override fun onWebRtcAudioTrackStop() { L.i("Audio", "AudioTrack STOP") }
            })
            .setAudioTrackErrorCallback(object : org.webrtc.audio.JavaAudioDeviceModule.AudioTrackErrorCallback {
                override fun onWebRtcAudioTrackInitError(msg: String) { L.w("Audio", "AudioTrack initError: $msg") }
                override fun onWebRtcAudioTrackStartError(
                    code: org.webrtc.audio.JavaAudioDeviceModule.AudioTrackStartErrorCode,
                    msg: String,
                ) { L.w("Audio", "AudioTrack startError: code=$code msg=$msg") }
                override fun onWebRtcAudioTrackError(msg: String) { L.w("Audio", "AudioTrack error: $msg") }
            })
            .createAudioDeviceModule()
        val factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
        return factory to adm
    }

    val peerFactory: () -> SpeechmuxPeer = {
        val (factory, adm) = newPeerConnectionFactoryAndAdm()
        SpeechmuxPeerImpl(
            factory,
            adm,
            httpClient = httpClient,
            preferredInputDevice = callAudioRouter?.preferredInputDevice,
        )
    }

    /**
     * API 31+ only. Owns the comm-device selection while a call is active
     * (BT SCO when AA / a headset is connected, builtin earpiece / speaker
     * otherwise). On API 26–30 this is null and CallControllerImpl falls
     * back to Telecom-driven routing.
     */
    val callAudioRouter: CallAudioRouter? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            CallAudioRouter(
                appContext.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager,
            )
        } else {
            null
        }

    val callController: CallController =
        CallControllerImpl(wsClient, peerFactory, applicationScope, callAudioRouter)

    /**
     * Proximity-to-ear screen blanking. Acquired while the call is held to the
     * head (Active + earpiece), released on speaker/BT/headset and when the
     * call ends. See [shouldHoldProximityLock].
     */
    val proximityScreenLock: ProximityScreenLock = ProximityScreenLock(appContext)

    init {
        // "Call started" is one business operation that has two visible
        // effects: the persistent call notification and the in-call screen.
        // Both live inside [CallForegroundService] so they fire from one
        // handler with one ordering guarantee — the foreground service is up
        // (BAL exemption granted) before the activity launch is attempted,
        // and the notification carries a fullScreenIntent fallback for the
        // cases where the OS still blocks the activity launch.
        //
        // The service starts on the Idle→non-Idle edge and self-stops once
        // the call returns to Ended/Idle.
        applicationScope.launch {
            callController.state
                .map { s -> s !is CallState.Idle && s !is CallState.Ended }
                .onEdge { prev, cur -> cur && prev != true }
                .collect { CallForegroundService.start(appContext) }
        }

        // Drive the proximity-to-ear screen lock off call state + audio route.
        applicationScope.launch {
            kotlinx.coroutines.flow.combine(
                callController.state,
                callController.audioRoute,
                callController.isSpeakerphoneOn,
            ) { state, route, speakerOn ->
                shouldHoldProximityLock(state, route, speakerOn)
            }.collect { hold -> proximityScreenLock.apply(hold) }
        }
    }

    companion object {
        private fun audioModeName(mode: Int): String = when (mode) {
            android.media.AudioManager.MODE_NORMAL -> "NORMAL"
            android.media.AudioManager.MODE_RINGTONE -> "RINGTONE"
            android.media.AudioManager.MODE_IN_CALL -> "IN_CALL"
            android.media.AudioManager.MODE_IN_COMMUNICATION -> "IN_COMMUNICATION"
            else -> "UNKNOWN($mode)"
        }
    }
}
