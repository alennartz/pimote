package com.pimote.android.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
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
 */
class SettingsImpl(
    private val appContext: Context,
    private val scope: CoroutineScope,
) : Settings {

    private val store: DataStore<Preferences> = appContext.settingsDataStore
    private val originKey = stringPreferencesKey("pimote_origin")

    private val _current = MutableStateFlow<Settings.Config?>(null)
    override val current: StateFlow<Settings.Config?> = _current.asStateFlow()

    init {
        scope.launch {
            val prefs = store.data.first()
            val origin = prefs[originKey]
            _current.value = origin?.let { Settings.Config(it) }
        }
    }

    override suspend fun set(config: Settings.Config) {
        store.edit { it[originKey] = config.pimoteOrigin }
        _current.value = config
    }

    override suspend fun clear() {
        store.edit { it.remove(originKey) }
        _current.value = null
    }
}
