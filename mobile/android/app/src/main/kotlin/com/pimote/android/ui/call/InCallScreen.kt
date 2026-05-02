package com.pimote.android.ui.call

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pimote.android.app.AppContainer
import com.pimote.android.call.CallEndReason
import com.pimote.android.call.CallState
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class CallViewModel : ViewModel() {
    private val container = AppContainer.instance
    val state: StateFlow<CallState> = container.callController.state

    fun endCall() {
        viewModelScope.launch { container.callController.endCurrentCall() }
    }
}

@Composable
fun InCallScreen(
    viewModel: CallViewModel,
    onClose: () -> Unit,
) {
    val state by viewModel.state.collectAsState()
    var muted by remember { mutableStateOf(false) }
    val isEnded = state is CallState.Ended

    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Pimote call", style = MaterialTheme.typography.titleMedium)
            Text(describe(state))
            (state as? CallState.Ended)?.let { ended ->
                Text(
                    "Reason: ${describeReason(ended.reason)}",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Spacer(Modifier.height(24.dp))
            if (isEnded) {
                Button(onClick = onClose) { Text("Close") }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Button(onClick = { muted = !muted }) {
                        Text(if (muted) "Unmute" else "Mute")
                    }
                    Button(onClick = { viewModel.endCall() }) {
                        Text("Hang up")
                    }
                }
            }
        }
    }
}

private fun describe(state: CallState): String = when (state) {
    CallState.Idle -> "Idle"
    is CallState.Dialing -> "Dialing\u2026"
    is CallState.Binding -> "Binding\u2026"
    is CallState.Negotiating -> "Negotiating\u2026"
    is CallState.Active -> "Connected (${state.sessionId})"
    is CallState.Ended -> "Call ended"
}

private fun describeReason(r: CallEndReason): String = when (r) {
    CallEndReason.USER_HANGUP -> "Hung up"
    CallEndReason.REMOTE_HANGUP -> "Remote hung up"
    CallEndReason.DISPLACED -> "Displaced by another client"
    CallEndReason.SERVER_ENDED -> "Server ended call"
    CallEndReason.PEER_FAILED -> "Voice peer failed (signaling/ICE)"
    CallEndReason.BIND_FAILED -> "Could not bind call"
}

/**
 * Thin Activity hosting the in-call Compose screen. Launched by
 * [com.pimote.android.app.AppContainer] on the Idle\u2192non-Idle edge of
 * `CallController.state`, so it covers the full lifecycle including the
 * pre-Active states and the terminal Ended state (where the user must
 * dismiss it manually so the failure reason is readable).
 */
class InCallActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val vm = CallViewModel()
        // Auto-finish only when the controller goes back to Idle. We
        // deliberately do NOT finish on Ended \u2014 that state holds the
        // failure reason for the user; they dismiss via the Close button.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                vm.state.collect { s ->
                    if (s is CallState.Idle) finish()
                }
            }
        }
        setContent { InCallScreen(vm, onClose = { finish() }) }
    }
}
