package com.pimote.android.settings

import android.content.Context
import android.util.Base64
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.pimote.android.auth.SecretVault
import com.pimote.android.util.L
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "pimote_settings")

/**
 * Production [Settings] backed by androidx.datastore. The persisted value is
 * mirrored into a [MutableStateFlow] so observers (Compose, the WsClient
 * bootstrap watcher) see synchronous updates.
 *
 * The Cloudflare Access service-token secret is encrypted with [SecretVault]
 * before persistence. The client id is stored in cleartext (it isn't secret;
 * it only identifies which token is in use).
 */
class SettingsImpl(
    appContext: Context,
    private val scope: CoroutineScope,
) : Settings {

    private val store: DataStore<Preferences> = appContext.settingsDataStore
    private val originKey = stringPreferencesKey("pimote_origin")
    private val accessClientIdKey = stringPreferencesKey("access_client_id")
    private val accessClientSecretBlobKey = stringPreferencesKey("access_client_secret_blob_b64")

    private val _current = MutableStateFlow<Settings.Config?>(null)
    override val current: StateFlow<Settings.Config?> = _current.asStateFlow()

    init {
        scope.launch {
            val prefs = store.data.first()
            val origin = prefs[originKey] ?: return@launch
            val clientId = prefs[accessClientIdKey]?.takeIf { it.isNotBlank() }
            val clientSecret = prefs[accessClientSecretBlobKey]?.let { decodeSecret(it) }
            _current.value = Settings.Config(
                pimoteOrigin = origin,
                accessClientId = clientId,
                accessClientSecret = clientSecret,
            )
        }
    }

    override suspend fun set(config: Settings.Config) {
        store.edit { prefs ->
            prefs[originKey] = config.pimoteOrigin
            val id = config.accessClientId?.takeIf { it.isNotBlank() }
            val secret = config.accessClientSecret?.takeIf { it.isNotBlank() }
            if (id != null) prefs[accessClientIdKey] = id else prefs.remove(accessClientIdKey)
            if (secret != null) {
                prefs[accessClientSecretBlobKey] = encodeSecret(secret)
            } else {
                prefs.remove(accessClientSecretBlobKey)
            }
        }
        // Round-trip through the same normalization the load path applies so
        // the in-memory mirror matches what's on disk.
        _current.value = config.copy(
            accessClientId = config.accessClientId?.takeIf { it.isNotBlank() },
            accessClientSecret = config.accessClientSecret?.takeIf { it.isNotBlank() },
        )
    }

    override suspend fun clear() {
        store.edit { it.clear() }
        _current.value = null
    }

    private fun encodeSecret(plain: String): String {
        val sealed = SecretVault.seal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(sealed, Base64.NO_WRAP)
    }

    private fun decodeSecret(b64: String): String? {
        return try {
            val blob = Base64.decode(b64, Base64.NO_WRAP)
            String(SecretVault.open(blob), Charsets.UTF_8)
        } catch (t: Throwable) {
            // Keystore key was likely regenerated (factory reset, app data
            // wipe-but-not-uninstall, restored backup on a new device, etc.).
            // The blob is unrecoverable; surface as "not configured" so the
            // user is taken back to setup to re-enter the secret.
            L.w("Settings", "failed to decrypt access client secret; treating as missing", t)
            null
        }
    }
}
