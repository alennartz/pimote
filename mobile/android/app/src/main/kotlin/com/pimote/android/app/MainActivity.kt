package com.pimote.android.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import com.pimote.android.ui.theme.PimoteTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pimote.android.ui.contacts.ContactsScreen
import com.pimote.android.ui.contacts.ContactsViewModel
import com.pimote.android.ui.setup.SetupScreen
import com.pimote.android.ui.setup.SetupViewModel
import com.pimote.android.util.L

private enum class Route { Setup, Contacts }

class MainActivity : ComponentActivity() {

    private var currentRoute by mutableStateOf(Route.Contacts)

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { results ->
        val denied = results.filterValues { !it }.keys
        if (denied.isNotEmpty()) {
            // Not fatal here — placeCall will surface a clear error if RECORD_AUDIO is
            // missing when the user taps a contact. We just log so the cause is visible
            // in logcat for the next "Permission missing for placeCall" report.
            L.w("MainActivity", "runtime permissions denied: $denied")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        requestRuntimePermissionsIfNeeded()

        // Start on Setup if there's no saved config; otherwise jump straight to Contacts.
        val container = AppContainer.instance
        currentRoute = if (container.settings.current.value == null) Route.Setup else Route.Contacts

        // Back from Contacts -> Setup. Back from Setup -> finish (default).
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (currentRoute == Route.Contacts) {
                    currentRoute = Route.Setup
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        setContent {
            PimoteTheme {
                Root(
                    route = currentRoute,
                    onNavigate = { currentRoute = it },
                )
            }
        }
    }

    /**
     * Request the runtime ("dangerous") permissions Telecom needs for self-managed
     * calls. Both `RECORD_AUDIO` and `BLUETOOTH_CONNECT` are declared in the manifest
     * but must be granted at runtime on API 23+ / 31+ respectively.
     *
     * `RECORD_AUDIO` is required by [android.telecom.TelecomManager.placeCall] for
     * self-managed PhoneAccounts — without it, placeCall throws SecurityException
     * ("Self-managed phone accounts require microphone permission to place calls.").
     * `BLUETOOTH_CONNECT` is needed on API 31+ for Telecom to surface BT headsets
     * in the in-call audio-route picker.
     *
     * Idempotent: if everything is already granted, no dialog is shown.
     */
    private fun requestRuntimePermissionsIfNeeded() {
        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            // ContactSyncRunner writes session/project rows under the Pimote
            // Account from the Application process. CALLER_IS_SYNCADAPTER does
            // not waive permission checks for non-SyncAdapter callers.
            add(Manifest.permission.READ_CONTACTS)
            add(Manifest.permission.WRITE_CONTACTS)
        }.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    @Composable
    private fun Root(route: Route, onNavigate: (Route) -> Unit) {
        when (route) {
            Route.Setup -> SetupScreen(
                viewModel = viewModel<SetupViewModel>(),
                onConnected = { onNavigate(Route.Contacts) },
            )
            Route.Contacts -> ContactsScreen(
                viewModel = viewModel<ContactsViewModel>(),
                onEditSettings = { onNavigate(Route.Setup) },
            )
        }
    }
}
