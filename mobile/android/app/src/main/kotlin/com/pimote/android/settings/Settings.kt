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
    /**
     * Persisted app config.
     *
     * [accessClientId] / [accessClientSecret] are an optional Cloudflare
     * Access service-token pair. When both are non-null/non-blank, every
     * outbound HTTP/WS request adds `CF-Access-Client-Id` and
     * `CF-Access-Client-Secret` headers (see `AccessAuthInterceptor`),
     * letting the app reach a Zero Trust–protected origin without WARP.
     * Empty values preserve the legacy network-layer-auth posture.
     *
     * The secret is encrypted at rest via `SecretVault` (AndroidKeyStore-
     * backed AES/GCM) before being written to DataStore. In-memory it is
     * a plain [String] because OkHttp needs it that way at request time.
     */
    data class Config(
        val pimoteOrigin: String,
        val accessClientId: String? = null,
        val accessClientSecret: String? = null,
    )

    /** Current config; null until [set] has been called at least once. */
    val current: StateFlow<Config?>

    /** Persist a new config and update [current]. */
    suspend fun set(config: Config)

    /** Erase persisted config and reset [current] to null. */
    suspend fun clear()
}
