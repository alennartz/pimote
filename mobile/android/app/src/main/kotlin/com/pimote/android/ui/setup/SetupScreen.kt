package com.pimote.android.ui.setup

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import com.pimote.android.app.AppContainer
import com.pimote.android.net.WsState
import com.pimote.android.settings.Settings
import com.pimote.android.ui.components.PimoteButton
import com.pimote.android.ui.components.PimoteButtonVariant
import com.pimote.android.ui.components.PimoteOutlinedTextField
import com.pimote.android.ui.components.PimoteSnackbarHost
import com.pimote.android.ui.components.PimoteSnackbarVariant
import com.pimote.android.ui.components.StatusPill
import com.pimote.android.ui.components.StatusPillState
import com.pimote.android.ui.theme.PimoteTheme
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
    // `current` is a StateFlow that starts at null on cold start and only emits the persisted
    // config after disk I/O completes. Seed `origin` once the value arrives, but only if the
    // user hasn't started typing yet (origin still blank).
    LaunchedEffect(current) {
        val persisted = current?.pimoteOrigin
        if (!persisted.isNullOrBlank() && origin.isBlank()) {
            origin = persisted
        }
    }
    var inFlight by remember { mutableStateOf(false) }
    var connectError by remember { mutableStateOf<String?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = PimoteTheme.colors.surfacePlus,
                ),
            )
        },
        snackbarHost = { PimoteSnackbarHost(snackbar, variant = PimoteSnackbarVariant.Error) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(
                    horizontal = PimoteTheme.spacing.ml,
                    vertical = PimoteTheme.spacing.l,
                ),
            verticalArrangement = Arrangement.spacedBy(PimoteTheme.spacing.m),
        ) {
            Text(
                "Enter the URL of your pimote server. Auth is handled at the network layer (VPN/Tailscale/LAN); the app does not handle login itself.",
                style = PimoteTheme.typography.bodyMedium,
                color = PimoteTheme.colors.inkSecondary,
            )
            PimoteOutlinedTextField(
                value = origin,
                onValueChange = { origin = it },
                label = "Pimote server URL",
                placeholder = "https://pimote.example.com",
                singleLine = true,
                enabled = !inFlight,
                isError = connectError != null,
                errorMessage = connectError,
            )
            PimoteButton(
                label = if (inFlight) "Connecting…" else "Connect",
                onClick = {
                    scope.launch {
                        connectError = null
                        inFlight = true
                        val r = viewModel.saveAndConnect(origin)
                        inFlight = false
                        if (r.isSuccess) {
                            connectError = null
                            onConnected()
                        } else {
                            val msg = r.exceptionOrNull()?.message ?: "unknown error"
                            L.w("Setup", "connect failed: $msg")
                            connectError = "Connect failed: $msg"
                            snackbar.showSnackbar("Connect failed: $msg")
                        }
                    }
                },
                variant = PimoteButtonVariant.Primary,
                enabled = origin.isNotBlank() && !inFlight,
                isLoading = inFlight,
            )

            StatusPill(
                state = when (val s = wsState) {
                    WsState.Disconnected -> StatusPillState.Disconnected
                    WsState.Connecting -> StatusPillState.Connecting
                    WsState.Connected -> StatusPillState.Connected
                    is WsState.Reconnecting -> StatusPillState.Reconnecting(s.attempt)
                    is WsState.Failed -> StatusPillState.Failed(s.reason)
                },
            )

            // If the user is already connected, offer a one-tap continue.
            if (wsState is WsState.Connected && current != null && !inFlight) {
                PimoteButton(
                    label = "Continue to contacts",
                    onClick = onConnected,
                    variant = PimoteButtonVariant.Secondary,
                )
            }
        }
    }
}
