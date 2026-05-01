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

    val peerFactory: () -> SpeechmuxPeer = { SpeechmuxPeerImpl(appContext) }

    val callController: CallController =
        CallControllerImpl(wsClient, peerFactory, applicationScope)

    companion object {
        @Volatile private var _instance: AppContainer? = null
        val instance: AppContainer
            get() = _instance ?: error("AppContainer not initialized")

        internal fun install(c: AppContainer) { _instance = c }
    }
}
