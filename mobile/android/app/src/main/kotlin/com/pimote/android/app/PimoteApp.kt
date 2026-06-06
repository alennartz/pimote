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

    /**
     * The single [AppContainer] for this process, owned by [Application]
     * itself — the legitimate process-scoped object Android already gives
     * us. Framework-instantiated callers (Activity / Service /
     * ConnectionService) reach this via
     * `(applicationContext as PimoteApp).container` (see
     * [Context.pimoteContainer]). There is no separate companion-object
     * singleton and no @Volatile install() hop; the dependency graph is
     * visible at every call site.
     */
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(applicationContext)

        // Bootstrap when (and only when) the user has configured an origin.
        container.applicationScope.launch {
            container.settings.current.collect { config ->
                if (config != null) {
                    container.wsClient.connect(config.pimoteOrigin)
                    container.sessionRepository.start()
                    container.phoneAccountRegistrar.start()
                    container.contactSyncRunner.start()
                    container.shortcutsRunner.start()
                }
            }
        }
    }
}

/**
 * Resolve the process-wide [AppContainer] from any [android.content.Context].
 * Uses the [android.app.Application] instance the platform already provides
 * — not a separate global. Callable from Activity / Service /
 * ConnectionService / Composable boundaries.
 */
val android.content.Context.pimoteContainer: AppContainer
    get() = (applicationContext as PimoteApp).container
