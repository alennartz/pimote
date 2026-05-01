package com.pimote.android.ui.call

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
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
import com.pimote.android.call.CallController
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
fun InCallScreen(viewModel: CallViewModel) {
    val state by viewModel.state.collectAsState()
    var muted by remember { mutableStateOf(false) }

    Scaffold { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Pimote call")
            Text(describe(state))
            Spacer(Modifier.height(24.dp))
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

private fun describe(state: CallState): String = when (state) {
    CallState.Idle -> "Idle"
    is CallState.Dialing -> "Dialing…"
    is CallState.Binding -> "Binding…"
    is CallState.Negotiating -> "Negotiating…"
    is CallState.Active -> "Connected (${state.sessionId})"
    is CallState.Ended -> "Ended (${state.reason})"
}

/**
 * Thin Activity hosting the in-call Compose screen. Telecom launches this via
 * the `android.telecom.action.SHOW_INCALL` family of intents wired through the
 * manifest. The activity finishes itself when the controller transitions to
 * Idle/Ended.
 */
class InCallActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val vm = CallViewModel()
        // Auto-finish when the controller leaves an active call.
        @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
        kotlinx.coroutines.GlobalScope.launch {
            vm.state.collect { s ->
                if (s is CallState.Ended || s is CallState.Idle) runOnUiThread { finish() }
            }
        }
        setContent { InCallScreen(vm) }
    }
}
