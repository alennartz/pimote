package com.pimote.android.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.pimote.android.ui.theme.PimoteTheme
import kotlinx.coroutines.delay

sealed interface StatusPillState {
    data object Connected : StatusPillState
    data object Connecting : StatusPillState
    data class Reconnecting(val attempt: Int) : StatusPillState
    data class Failed(val reason: String) : StatusPillState
    data object Disconnected : StatusPillState
}

@Composable
fun StatusPill(
    state: StatusPillState,
    onTap: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val dotColor: Color = when (state) {
        StatusPillState.Connected -> PimoteTheme.colors.active
        StatusPillState.Connecting -> PimoteTheme.colors.warning
        is StatusPillState.Reconnecting -> PimoteTheme.colors.warning
        is StatusPillState.Failed -> PimoteTheme.colors.danger
        StatusPillState.Disconnected -> PimoteTheme.colors.idle
    }
    val label: String = when (state) {
        StatusPillState.Connected -> "Connected"
        StatusPillState.Connecting -> "Connecting…"
        is StatusPillState.Reconnecting -> "Reconnecting · attempt ${state.attempt}"
        is StatusPillState.Failed -> "Failed: ${cleanStatusReason(state.reason)}"
        StatusPillState.Disconnected -> "Disconnected"
    }

    var collapsed by remember { mutableStateOf(false) }
    var expandTrigger by remember { mutableIntStateOf(0) }

    // Auto-collapse 3s after entering Connected (or after a tap-to-expand).
    LaunchedEffect(state, expandTrigger) {
        collapsed = false
        if (state == StatusPillState.Connected) {
            delay(3000)
            collapsed = true
        }
    }

    val shape = RoundedCornerShape(12.dp)
    val monoFamily = PimoteTheme.typography.mono14.fontFamily
    val labelStyle = PimoteTheme.typography.labelMedium.copy(fontFamily = monoFamily)

    AnimatedContent(
        targetState = collapsed,
        transitionSpec = { fadeIn(tween(150)) togetherWith fadeOut(tween(150)) },
        label = "StatusPill",
        modifier = modifier,
    ) { isCollapsed ->
        if (isCollapsed) {
            Box(
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .clickable {
                        onTap()
                        expandTrigger++
                    }
                    .padding(PaddingValues(horizontal = 12.dp, vertical = 8.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .background(dotColor, CircleShape),
                )
            }
        } else {
            Row(
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .background(PimoteTheme.colors.surfacePlus, shape)
                    .clickable { onTap() }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .background(dotColor, CircleShape),
                )
                Text(
                    text = label,
                    style = labelStyle,
                    color = PimoteTheme.colors.ink,
                )
            }
        }
    }
}

@Preview
@Composable
private fun StatusPillPreviewConnected() {
    PimoteTheme { StatusPill(StatusPillState.Connected) }
}

@Preview
@Composable
private fun StatusPillPreviewConnecting() {
    PimoteTheme { StatusPill(StatusPillState.Connecting) }
}

@Preview
@Composable
private fun StatusPillPreviewReconnecting() {
    PimoteTheme { StatusPill(StatusPillState.Reconnecting(2)) }
}

@Preview
@Composable
private fun StatusPillPreviewFailed() {
    PimoteTheme { StatusPill(StatusPillState.Failed("ws error: connection refused")) }
}

@Preview
@Composable
private fun StatusPillPreviewDisconnected() {
    PimoteTheme { StatusPill(StatusPillState.Disconnected) }
}
