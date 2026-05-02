package com.pimote.android.ui.call

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewModelScope
import com.pimote.android.R
import com.pimote.android.app.AppContainer
import com.pimote.android.call.CallState
import com.pimote.android.ui.components.AvatarRing
import com.pimote.android.ui.theme.PimoteTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class CallViewModel : ViewModel() {
    private val container = AppContainer.instance
    val state: StateFlow<CallState> = container.callController.state

    val sessionDisplayName: StateFlow<String?> = combine(
        container.callController.state,
        container.sessionRepository.sessions,
    ) { callState, sessions ->
        val sid: String? = when (callState) {
            is CallState.Binding -> callState.sessionId
            is CallState.Negotiating -> callState.sessionId
            is CallState.Active -> callState.sessionId
            is CallState.Ended -> callState.sessionId
            is CallState.Dialing,
            CallState.Idle -> null
        }
        sid?.let { id ->
            sessions.firstOrNull { it.sessionId == id }?.let {
                it.name?.takeIf { n -> n.isNotBlank() } ?: "Untitled session"
            }
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

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
    val sessionName by viewModel.sessionDisplayName.collectAsState()
    var muted by remember { mutableStateOf(false) }
    val isEnded = state is CallState.Ended
    val isActive = state is CallState.Active

    var durationSeconds by remember { mutableStateOf(0L) }
    LaunchedEffect(isActive) {
        if (isActive) {
            durationSeconds = 0L
            while (true) {
                delay(1000)
                durationSeconds++
            }
        }
    }

    val avatarRingState = deriveAvatarRingState(state, durationSeconds)
    val monogram = sessionName?.firstOrNull()?.uppercaseChar()?.toString() ?: "P"
    val colors = PimoteTheme.colors
    val spacing = PimoteTheme.spacing
    val typography = PimoteTheme.typography

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.void),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Header zone
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = spacing.xl, bottom = spacing.m),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (isEnded) {
                IconButton(onClick = onClose) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Close",
                        tint = colors.ink,
                    )
                }
            }
            Text(
                text = sessionName ?: "Pimote",
                style = typography.titleLarge,
                color = colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "Voice call",
                style = typography.bodyMedium,
                color = colors.inkSecondary,
            )
        }

        // Avatar zone (vertically centered, takes remaining space)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            contentAlignment = Alignment.Center,
        ) {
            AvatarRing(monogram = monogram, state = avatarRingState, isMuted = muted)
        }

        // Action zone
        Surface(
            color = colors.surface,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = spacing.l, bottom = spacing.xxl),
        ) {
            if (isEnded) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = spacing.l),
                    contentAlignment = Alignment.Center,
                ) {
                    com.pimote.android.ui.components.PimoteButton(
                        label = "Close",
                        onClick = onClose,
                        variant = com.pimote.android.ui.components.PimoteButtonVariant.Secondary,
                    )
                }
            } else {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = spacing.l),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Mute button — 64dp circular
                    Box(
                        modifier = Modifier
                            .size(64.dp)
                            .clip(CircleShape)
                            .background(if (muted) colors.warning else colors.surfacePlus)
                            .clickable { muted = !muted },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            painter = painterResource(
                                if (muted) R.drawable.ic_mic_off else R.drawable.ic_mic_outlined,
                            ),
                            contentDescription = if (muted) "Unmute" else "Mute",
                            tint = colors.ink,
                            modifier = Modifier.size(28.dp),
                        )
                    }
                    Spacer(Modifier.width(spacing.l))
                    // Hang up button — 72dp circular
                    Box(
                        modifier = Modifier
                            .size(72.dp)
                            .clip(CircleShape)
                            .background(colors.danger)
                            .clickable(enabled = !isEnded) { viewModel.endCall() },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            painter = painterResource(R.drawable.ic_call_end),
                            contentDescription = "Hang up",
                            tint = Color.White,
                            modifier = Modifier.size(32.dp),
                        )
                    }
                }
            }
        }
    }
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
        setContent { PimoteTheme { InCallScreen(vm, onClose = { finish() }) } }
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Auto-finish only when the controller goes back to Idle. We
        // deliberately do NOT finish on Ended \u2014 that state holds the
        // failure reason for the user; they dismiss via the Close button.
        // Clear FLAG_KEEP_SCREEN_ON when the call ends.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                vm.state.collect { s ->
                    if (s is CallState.Ended) {
                        window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                    if (s is CallState.Idle) finish()
                }
            }
        }
    }
}
