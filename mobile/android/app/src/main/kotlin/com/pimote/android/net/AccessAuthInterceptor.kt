package com.pimote.android.net

import com.pimote.android.settings.Settings
import kotlinx.coroutines.flow.StateFlow
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Adds Cloudflare Access service-token headers to every outbound request
 * when the user has configured them in settings.
 *
 * Reads from [Settings.current] synchronously via the cached [StateFlow]
 * value — no suspending, no `runBlocking`. The bootstrap order in
 * [com.pimote.android.app.PimoteApp] guarantees that by the time any
 * HTTP/WS request fires, [SettingsImpl] has finished its initial DataStore
 * read and `current.value` is non-null.
 *
 * If credentials aren't set, the interceptor is a no-op — preserving the
 * legacy "auth at the network layer" posture (DR-017) for users on a VPN
 * or LAN-only setup.
 */
class AccessAuthInterceptor(
    private val settings: StateFlow<Settings.Config?>,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val cfg = settings.value
        val id = cfg?.accessClientId
        val secret = cfg?.accessClientSecret
        if (id.isNullOrBlank() || secret.isNullOrBlank()) {
            return chain.proceed(chain.request())
        }
        val authed = chain.request().newBuilder()
            .header("CF-Access-Client-Id", id)
            .header("CF-Access-Client-Secret", secret)
            .build()
        return chain.proceed(authed)
    }
}
