package com.pimote.android.contacts

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Bound service that exposes [PimoteSyncAdapter] to the system.
 * Bound by the platform on demand when sync requests are issued; we
 * never issue sync requests, but the binding metadata is what makes
 * the Pimote Account a recognized contacts source.
 *
 * Implementation pending — see plan
 * `docs/plans/android-assistant-discoverable-contacts.md`.
 */
class PimoteSyncAdapterService : Service() {

    @Volatile private var adapter: PimoteSyncAdapter? = null
    private val lock = Any()

    override fun onCreate() {
        super.onCreate()
        synchronized(lock) {
            if (adapter == null) {
                adapter = PimoteSyncAdapter(applicationContext, /* autoInitialize = */ true)
            }
        }
    }

    override fun onBind(intent: Intent): IBinder =
        (adapter ?: error("PimoteSyncAdapter not initialized")).syncAdapterBinder
}
