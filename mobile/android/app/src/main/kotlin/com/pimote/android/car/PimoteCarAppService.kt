package com.pimote.android.car

import androidx.car.app.CarAppService
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

/**
 * Android Auto entry point. Framework-instantiated; reads the process-wide
 * container via `carContext.pimoteContainer` from the screens it hosts.
 *
 * Thin host integration — no business logic. Permissive host validator is
 * acceptable for a sideloaded personal build.
 */
class PimoteCarAppService : CarAppService() {
    override fun createHostValidator(): HostValidator =
        HostValidator.ALLOW_ALL_HOSTS_VALIDATOR

    override fun onCreateSession(): Session = PimoteCarSession()
}
