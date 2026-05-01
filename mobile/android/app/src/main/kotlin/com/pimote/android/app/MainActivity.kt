package com.pimote.android.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pimote.android.ui.contacts.ContactsScreen
import com.pimote.android.ui.contacts.ContactsViewModel
import com.pimote.android.ui.setup.SetupScreen
import com.pimote.android.ui.setup.SetupViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Root()
            }
        }
    }
}

@Composable
private fun Root() {
    val container = AppContainer.instance
    val config by container.settings.current.collectAsState()
    if (config == null) {
        SetupScreen(viewModel = viewModel<SetupViewModel>())
    } else {
        ContactsScreen(viewModel = viewModel<ContactsViewModel>())
    }
}
