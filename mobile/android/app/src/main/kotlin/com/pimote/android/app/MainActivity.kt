package com.pimote.android.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pimote.android.ui.contacts.ContactsScreen
import com.pimote.android.ui.contacts.ContactsViewModel
import com.pimote.android.ui.setup.SetupScreen
import com.pimote.android.ui.setup.SetupViewModel

private enum class Route { Setup, Contacts }

class MainActivity : ComponentActivity() {

    private var currentRoute by mutableStateOf(Route.Contacts)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
            MaterialTheme {
                Root(
                    route = currentRoute,
                    onNavigate = { currentRoute = it },
                )
            }
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
