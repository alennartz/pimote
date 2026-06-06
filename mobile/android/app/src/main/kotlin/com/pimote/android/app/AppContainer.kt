package com.pimote.android.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import com.pimote.android.call.CallAudioRouter
import com.pimote.android.call.CallController
import com.pimote.android.call.CallControllerImpl
import com.pimote.android.call.CallForegroundService
import com.pimote.android.call.CallState
import com.pimote.android.call.ProximityScreenLock
import com.pimote.android.call.shouldHoldProximityLock
import com.pimote.android.ui.call.InCallActivity
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
    // Audio source is VOICE_COMMUNICATION (the JavaADM default). This is the
    // source that follows the active communication device selected by
    // `AudioManager.setCommunicationDevice`, which is what makes BT HFP/SCO
    // routing work for Bluetooth headsets and Android Auto. The previous
    // VOICE_RECOGNITION workaround — chosen to bypass Pixel's FORTEMEDIA
    // "AMixMODEM" telephony DSP gain-zero bug on local-mic capture — had the
    // side effect of pinning capture to the builtin mic and breaking AA. If
    // the Pixel uplink-gain-zero issue resurfaces on speakerphone-only calls
    // it should be addressed at its real root (e.g. disabling platform AEC/NS
    // effects on the AudioRecord session, or using UNPROCESSED source), not
    // by re-pinning the source.
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
            .setAudioSource(android.media.MediaRecorder.AudioSource.VOICE_COMMUNICATION)
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
        // Drive the persistent call notification (foreground service, type
        // phoneCall). Started on the edge where the call leaves Idle; the
        // service self-stops once the call reaches Ended/Idle.
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
            callController.state
                .map { it is CallState.Idle }
                // Initial state is Idle, so treat the very first emission as
                // "was already idle" — the cold-start case shouldn't fire
                // the in-call activity. Hence prev == null → false.
                .onEdge { prev, cur -> prev == true && !cur }
                .collect {
                    val intent = Intent(appContext, InCallActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    appContext.startActivity(intent)
                }
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
