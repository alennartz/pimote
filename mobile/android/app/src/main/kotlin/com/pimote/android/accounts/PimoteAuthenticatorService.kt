package com.pimote.android.accounts

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Service that exposes [PimoteAccountAuthenticator] to the system
 * AccountManager. Bound by AccountManager via the
 * `android.accounts.AccountAuthenticator` intent action and the
 * `BIND_ACCOUNT_AUTHENTICATOR` permission (system-only). See
 * AndroidManifest.xml.
 */
class PimoteAuthenticatorService : Service() {
    private lateinit var authenticator: PimoteAccountAuthenticator

    override fun onCreate() {
        super.onCreate()
        authenticator = PimoteAccountAuthenticator(this)
    }

    override fun onBind(intent: Intent?): IBinder = authenticator.iBinder
}
