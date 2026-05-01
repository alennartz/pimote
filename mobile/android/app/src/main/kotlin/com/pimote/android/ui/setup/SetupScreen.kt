package com.pimote.android.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pimote.android.app.AppContainer
import com.pimote.android.net.WsState
import com.pimote.android.settings.Settings
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class SetupViewModel : ViewModel() {
    private val container = AppContainer.instance
    val current: StateFlow<Settings.Config?> = container.settings.current
    val wsState: StateFlow<WsState> = container.wsClient.state

    fun connect(origin: String) {
        viewModelScope.launch {
            container.settings.set(Settings.Config(origin.trim()))
            container.wsClient.connect(origin.trim())
        }
    }

    suspend fun testConnection(): Result<Unit> = runCatching {
        container.sessionRepository.refresh()
    }
}

@Composable
fun SetupScreen(viewModel: SetupViewModel) {
    val current by viewModel.current.collectAsState()
    val wsState by viewModel.wsState.collectAsState()
    var origin by rememberSaveable { mutableStateOf(current?.pimoteOrigin ?: "") }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Pimote setup")
            OutlinedTextField(
                value = origin,
                onValueChange = { origin = it },
                label = { Text("Pimote URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = { viewModel.connect(origin) },
                enabled = origin.isNotBlank(),
            ) { Text("Connect") }
            Button(
                onClick = {
                    scope.launch {
                        val r = viewModel.testConnection()
                        snackbar.showSnackbar(
                            if (r.isSuccess) "OK" else "Failed: ${r.exceptionOrNull()?.message ?: "unknown"}",
                        )
                    }
                },
            ) { Text("Test connection") }
            Spacer(Modifier.height(8.dp))
            Text("Status: ${describe(wsState)}")
        }
    }
}

private fun describe(state: WsState): String = when (state) {
    WsState.Disconnected -> "disconnected"
    WsState.Connecting -> "connecting"
    WsState.Connected -> "connected"
    is WsState.Reconnecting -> "reconnecting (attempt ${state.attempt})"
    is WsState.Failed -> "failed: ${state.reason}"
}
