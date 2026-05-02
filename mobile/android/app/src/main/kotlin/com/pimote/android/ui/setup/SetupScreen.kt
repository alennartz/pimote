package com.pimote.android.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pimote.android.app.AppContainer
import com.pimote.android.net.WsState
import com.pimote.android.settings.Settings
import com.pimote.android.util.L
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

class SetupViewModel : ViewModel() {
    private val container = AppContainer.instance
    val current: StateFlow<Settings.Config?> = container.settings.current
    val wsState: StateFlow<WsState> = container.wsClient.state

    /** Persist the URL, kick off connect, and suspend until Connected (or timeout/fail). */
    suspend fun saveAndConnect(originRaw: String): Result<Unit> {
        val origin = originRaw.trim().trimEnd('/')
        if (origin.isBlank()) return Result.failure(IllegalArgumentException("URL is empty"))
        if (!origin.startsWith("http://") && !origin.startsWith("https://")) {
            return Result.failure(IllegalArgumentException("URL must start with http:// or https://"))
        }
        L.i("Setup", "saveAndConnect origin=$origin")
        container.settings.set(Settings.Config(origin))
        container.wsClient.connect(origin)

        val outcome = withTimeoutOrNull(15_000) {
            container.wsClient.state.first { it is WsState.Connected || it is WsState.Failed }
        }
        val tail = container.wsClient.lastFailure.value?.let { " (last error: $it)" } ?: ""
        return when (outcome) {
            is WsState.Connected -> Result.success(Unit)
            is WsState.Failed -> Result.failure(RuntimeException(outcome.reason + tail))
            null -> Result.failure(RuntimeException("timed out after 15s$tail"))
            else -> Result.failure(RuntimeException("unexpected state: $outcome$tail"))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SetupScreen(viewModel: SetupViewModel, onConnected: () -> Unit) {
    val current by viewModel.current.collectAsState()
    val wsState by viewModel.wsState.collectAsState()
    var origin by rememberSaveable { mutableStateOf(current?.pimoteOrigin ?: "") }
    var inFlight by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    // If we're already connected when the user opens this screen, surface that.
    Scaffold(
        topBar = { TopAppBar(title = { Text("Pimote setup") }) },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                "Enter the URL of your pimote server. Auth is handled at the network layer (VPN/Tailscale/LAN); the app does not handle login itself.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = origin,
                onValueChange = { origin = it },
                label = { Text("Pimote URL") },
                placeholder = { Text("https://pimote.example.com") },
                singleLine = true,
                enabled = !inFlight,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Button(
                    onClick = {
                        scope.launch {
                            inFlight = true
                            val r = viewModel.saveAndConnect(origin)
                            inFlight = false
                            if (r.isSuccess) {
                                onConnected()
                            } else {
                                val msg = r.exceptionOrNull()?.message ?: "unknown error"
                                L.w("Setup", "connect failed: $msg")
                                snackbar.showSnackbar("Connect failed: $msg")
                            }
                        }
                    },
                    enabled = origin.isNotBlank() && !inFlight,
                ) { Text(if (inFlight) "Connecting…" else "Connect") }

                if (inFlight) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp))
                }
            }

            Spacer(Modifier.height(8.dp))
            ConnectionStatusBlock(wsState)

            // If the user is already connected, offer a one-tap continue.
            if (wsState is WsState.Connected && current != null && !inFlight) {
                Button(onClick = onConnected) { Text("Continue to contacts") }
            }
        }
    }
}

@Composable
private fun ConnectionStatusBlock(state: WsState) {
    val (label, color) = when (state) {
        WsState.Disconnected -> "Disconnected" to Color(0xFF888888)
        WsState.Connecting -> "Connecting…" to Color(0xFFE0A800)
        WsState.Connected -> "Connected" to Color(0xFF2E7D32)
        is WsState.Reconnecting -> "Reconnecting (attempt ${state.attempt}, next in ${state.nextDelayMs / 1000}s)" to Color(0xFFE0A800)
        is WsState.Failed -> "Failed: ${state.reason}" to Color(0xFFB00020)
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Status", style = MaterialTheme.typography.labelMedium)
        Text(label, color = color, fontFamily = FontFamily.Monospace)
    }
}
