package com.pimote.android.app

import android.app.Application
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/**
 * Pimote application entry point. Owns the [AppContainer] singleton.
 *
 * The app does not start the WS connection until the user has configured a
 * pimote origin via the setup screen. When `Settings.current` becomes
 * non-null, we kick off `WsClient.connect`, `SessionRepository.start`, and
 * `PhoneAccountRegistrar.start`.
 *
 * Risk flag: architecture risk #1 (dead-app voice-intent routing). v1
 * deliberately does NOT use a foreground service. If manual testing shows
 * Assistant fails to wake the app for voice intents, add a foreground
 * service in v1.1 — do not add startForeground here.
 */
class PimoteApp : Application() {

    override fun onCreate() {
        super.onCreate()
        val container = AppContainer(applicationContext)
        AppContainer.install(container)

        // Bootstrap when (and only when) the user has configured an origin.
        container.applicationScope.launch {
            container.settings.current.collect { config ->
                if (config != null) {
                    container.wsClient.connect(config.pimoteOrigin)
                    container.sessionRepository.start()
                    container.phoneAccountRegistrar.start()
                }
            }
        }
    }
}
