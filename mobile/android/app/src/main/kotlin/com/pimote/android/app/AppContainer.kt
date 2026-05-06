package com.pimote.android.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import com.pimote.android.call.CallController
import com.pimote.android.call.CallControllerImpl
import com.pimote.android.call.CallState
import com.pimote.android.ui.call.InCallActivity
import com.pimote.android.net.AccessAuthInterceptor
import com.pimote.android.net.AndroidNetworkAvailabilityMonitor
import com.pimote.android.net.OkHttpWsTransport
import com.pimote.android.net.WsClient
import com.pimote.android.net.WsClientImpl
import okhttp3.OkHttpClient
import com.pimote.android.session.SessionRepository
import com.pimote.android.session.SessionRepositoryImpl
import com.pimote.android.settings.Settings
import com.pimote.android.settings.SettingsImpl
import com.pimote.android.contacts.ContactSyncRunner
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
 * accessible via [AppContainer.instance] for framework-instantiated callers
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
    // the MODE_IN_COMMUNICATION audio mode that Telecom puts the system into
    // via setAudioModeIsVoip(true). Net effect: capture works, but inbound
    // audio renders to a stream that's effectively muted during a VoIP call,
    // so the user can't hear the model. JavaAudioDeviceModule uses
    // AudioAttributes.USAGE_VOICE_COMMUNICATION + CONTENT_TYPE_SPEECH for
    // playback and AudioRecord with VOICE_COMMUNICATION input — both aligned
    // with the call audio path Telecom is managing.
    //
    // Audio capture is configured to bypass Pixel's telephony DSP entirely:
    //
    //   - Audio source = VOICE_RECOGNITION (not the JavaADM default of
    //     VOICE_COMMUNICATION). On Pixel/Tensor, capturing from
    //     VOICE_COMMUNICATION while the system is in MODE_IN_COMMUNICATION
    //     routes the mic through the FORTEMEDIA "AMixMODEM" / "Telephony
    //     Voice Processor" chain. That chain has its own gain stage that,
    //     in self-managed Telecom VoIP calls, zeroes the uplink gain a few
    //     seconds in (`[AMixMODEM] pGainUL_: 0` in kernel logs). Server-side
    //     audio-level traces confirmed phone capture going to digital
    //     silence (RMS ~3e-6) for 40+ seconds. VOICE_RECOGNITION skips the
    //     telephony DSP entirely and gives us raw mic samples.
    //
    //   - HW AEC + HW NS disabled for the same reason: any audiofx effects
    //     re-engage parts of the FORTEMEDIA chain. WebRTC's software AEC3 +
    //     NS3 in the APM run by default (createAudioSource constraints) and
    //     handle echo/noise/AGC entirely in user space.
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
        SpeechmuxPeerImpl(factory, adm, httpClient = httpClient)
    }

    val callController: CallController =
        CallControllerImpl(wsClient, peerFactory, applicationScope)

    init {
        // Launch the custom in-call screen as soon as the controller leaves
        // Idle, so the user gets immediate feedback during Dialing/Binding/
        // Negotiating and on failure (Ended) — not only after Active.
        //
        // Plan step 16 prescribed an `android.intent.action.MAIN` +
        // `android.intent.category.CALL_LAUNCHER` filter to make Telecom drive
        // this — but `CALL_LAUNCHER` is not a real Android category, so the
        // mechanism the plan named would not fire. The standard
        // `SelfManagedConnectionService` pattern is to launch the custom UI
        // explicitly when the call transitions out of Idle; the activity's
        // `showWhenLocked` / `turnScreenOn` manifest flags handle wake/lock.
        //
        // We only fire on the Idle→non-Idle edge so we don't restart the
        // activity for every intra-call state change.
        applicationScope.launch {
            var prevIdle = true
            callController.state.collect { s ->
                val nowIdle = s is CallState.Idle
                if (prevIdle && !nowIdle) {
                    val intent = Intent(appContext, InCallActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    appContext.startActivity(intent)
                }
                prevIdle = nowIdle
            }
        }
    }

    companion object {
        @Volatile private var _instance: AppContainer? = null
        val instance: AppContainer
            get() = _instance ?: error("AppContainer not initialized")

        internal fun install(c: AppContainer) { _instance = c }

        private fun audioModeName(mode: Int): String = when (mode) {
            android.media.AudioManager.MODE_NORMAL -> "NORMAL"
            android.media.AudioManager.MODE_RINGTONE -> "RINGTONE"
            android.media.AudioManager.MODE_IN_CALL -> "IN_CALL"
            android.media.AudioManager.MODE_IN_COMMUNICATION -> "IN_COMMUNICATION"
            else -> "UNKNOWN($mode)"
        }
    }
}
