package com.pimote.android.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import com.pimote.android.call.CallController
import com.pimote.android.call.CallControllerImpl
import com.pimote.android.call.CallState
import com.pimote.android.ui.call.InCallActivity
import com.pimote.android.net.AndroidNetworkAvailabilityMonitor
import com.pimote.android.net.OkHttpWsTransport
import com.pimote.android.net.WsClient
import com.pimote.android.net.WsClientImpl
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

/**
 * Manual-DI container. Constructed once in [PimoteApp.onCreate] and made
 * accessible via [AppContainer.instance] for framework-instantiated callers
 * (the Telecom [PimoteConnectionService]) that cannot receive constructor
 * injection.
 */
class AppContainer(private val appContext: Context) {
    val applicationScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val settings: Settings = SettingsImpl(appContext, applicationScope)

    val wsClient: WsClient = WsClientImpl(
        transport = OkHttpWsTransport(),
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

    // Process-singleton WebRTC factory. PeerConnectionFactory.initialize and the
    // factory itself allocate non-trivial native state; creating a fresh one per
    // call leaks across repeated calls in the same process. The associated EglBase
    // is held here for the same reason and disposed only when the process winds
    // down (no explicit teardown in v1).
    private val eglBase: EglBase by lazy { EglBase.create() }
    val peerConnectionFactory: PeerConnectionFactory by lazy {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext)
                .createInitializationOptions(),
        )
        PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }

    val peerFactory: () -> SpeechmuxPeer = { SpeechmuxPeerImpl(peerConnectionFactory) }

    val callController: CallController =
        CallControllerImpl(wsClient, peerFactory, applicationScope)

    init {
        // Launch the custom in-call screen when the call goes Active.
        //
        // Plan step 16 prescribed an `android.intent.action.MAIN` +
        // `android.intent.category.CALL_LAUNCHER` filter to make Telecom drive
        // this — but `CALL_LAUNCHER` is not a real Android category, so the
        // mechanism the plan named would not fire. The standard
        // `SelfManagedConnectionService` pattern is to launch the custom UI
        // explicitly when the call transitions to Active; the activity's
        // `showWhenLocked` / `turnScreenOn` manifest flags handle wake/lock.
        applicationScope.launch {
            callController.state.collect { s ->
                if (s is CallState.Active) {
                    val intent = Intent(appContext, InCallActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    appContext.startActivity(intent)
                }
            }
        }
    }

    companion object {
        @Volatile private var _instance: AppContainer? = null
        val instance: AppContainer
            get() = _instance ?: error("AppContainer not initialized")

        internal fun install(c: AppContainer) { _instance = c }
    }
}
