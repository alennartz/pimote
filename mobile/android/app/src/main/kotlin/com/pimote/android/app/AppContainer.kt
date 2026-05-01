package com.pimote.android.app

import android.content.ComponentName
import android.content.Context
import com.pimote.android.call.CallController
import com.pimote.android.call.CallControllerImpl
import com.pimote.android.net.AndroidNetworkAvailabilityMonitor
import com.pimote.android.net.OkHttpWsTransport
import com.pimote.android.net.WsClient
import com.pimote.android.net.WsClientImpl
import com.pimote.android.session.SessionRepository
import com.pimote.android.session.SessionRepositoryImpl
import com.pimote.android.settings.Settings
import com.pimote.android.settings.SettingsImpl
import com.pimote.android.telephony.AndroidTelecomFacade
import com.pimote.android.telephony.PhoneAccountRegistrar
import com.pimote.android.telephony.PhoneAccountRegistrarImpl
import com.pimote.android.telephony.PimoteConnectionService
import com.pimote.android.voice.SpeechmuxPeer
import com.pimote.android.voice.SpeechmuxPeerImpl
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
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
class AppContainer(appContext: Context) {
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
    val phoneAccountRegistrar: PhoneAccountRegistrar =
        PhoneAccountRegistrarImpl(sessionRepository, telecomFacade, applicationScope)

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

    companion object {
        @Volatile private var _instance: AppContainer? = null
        val instance: AppContainer
            get() = _instance ?: error("AppContainer not initialized")

        internal fun install(c: AppContainer) { _instance = c }
    }
}
