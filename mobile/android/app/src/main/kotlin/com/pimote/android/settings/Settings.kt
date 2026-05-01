package com.pimote.android.settings

import kotlinx.coroutines.flow.StateFlow

/**
 * Persistent app config. The user enters one value (pimote origin) on first
 * launch. WsClient and SpeechmuxPeer read [Config.pimoteOrigin] from here.
 *
 * Implementation backed by androidx.datastore.preferences. No auth fields —
 * authentication is handled at the network layer outside the app.
 */
interface Settings {
    data class Config(val pimoteOrigin: String)

    /** Current config; null until [set] has been called at least once. */
    val current: StateFlow<Config?>

    /** Persist a new config and update [current]. */
    suspend fun set(config: Config)

    /** Erase persisted config and reset [current] to null. */
    suspend fun clear()
}
