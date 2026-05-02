package com.pimote.android.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.animateFloat
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.pimote.android.R
import com.pimote.android.ui.theme.PimoteTheme

sealed interface AvatarRingState {
    data class Connecting(val phaseLabel: String) : AvatarRingState
    data class Active(val durationSeconds: Long) : AvatarRingState
    data object EndedOk : AvatarRingState
    data class EndedError(val reason: String) : AvatarRingState
}

/**
 * Composite avatar ring used by the in-call screen. Renders a 120dp filled circle,
 * a state-driven ring around it (animated for [AvatarRingState.Connecting] and
 * [AvatarRingState.Active]), the monogram letter at the center, and a phase /
 * duration / reason label below the circle. Optionally shows a mute badge.
 */
@Composable
fun AvatarRing(
    monogram: String,
    state: AvatarRingState,
    isMuted: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val colors = PimoteTheme.colors
    val typography = PimoteTheme.typography
    val spacing = PimoteTheme.spacing

    val ringColor: Color = when (state) {
        is AvatarRingState.Connecting -> colors.active
        is AvatarRingState.Active -> colors.indigo
        AvatarRingState.EndedOk -> colors.idle
        is AvatarRingState.EndedError -> colors.danger
    }

    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(spacing.sm),
    ) {
        Box(
            modifier = Modifier.size(120.dp),
            contentAlignment = Alignment.Center,
        ) {
            // Filled circle background.
            Canvas(modifier = Modifier.size(120.dp)) {
                drawCircle(color = colors.surfacePlus)
            }

            when (state) {
                is AvatarRingState.Connecting -> {
                    val transition = rememberInfiniteTransition(label = "avatar-connecting")
                    val rotation by transition.animateFloat(
                        initialValue = 0f,
                        targetValue = 360f,
                        animationSpec = infiniteRepeatable(
                            animation = tween(durationMillis = 1200, easing = LinearEasing),
                        ),
                        label = "avatar-connecting-rotation",
                    )
                    Canvas(modifier = Modifier.size(120.dp)) {
                        rotate(degrees = rotation) {
                            drawCircle(
                                color = ringColor,
                                style = Stroke(
                                    width = 2.dp.toPx(),
                                    pathEffect = PathEffect.dashPathEffect(
                                        intervals = floatArrayOf(8.dp.toPx(), 6.dp.toPx()),
                                        phase = 0f,
                                    ),
                                ),
                            )
                        }
                    }
                }
                is AvatarRingState.Active -> {
                    val transition = rememberInfiniteTransition(label = "avatar-active")
                    val scale by transition.animateFloat(
                        initialValue = 1.0f,
                        targetValue = 1.06f,
                        animationSpec = infiniteRepeatable(
                            animation = tween(durationMillis = 2400, easing = FastOutSlowInEasing),
                            repeatMode = RepeatMode.Reverse,
                        ),
                        label = "avatar-active-scale",
                    )
                    val alpha by transition.animateFloat(
                        initialValue = 1.0f,
                        targetValue = 0.65f,
                        animationSpec = infiniteRepeatable(
                            animation = tween(durationMillis = 2400, easing = FastOutSlowInEasing),
                            repeatMode = RepeatMode.Reverse,
                        ),
                        label = "avatar-active-alpha",
                    )
                    Canvas(
                        modifier = Modifier
                            .size(120.dp)
                            .scale(scale)
                            .alpha(alpha),
                    ) {
                        drawCircle(
                            color = ringColor,
                            style = Stroke(width = 2.dp.toPx()),
                        )
                    }
                }
                AvatarRingState.EndedOk,
                is AvatarRingState.EndedError -> {
                    Canvas(modifier = Modifier.size(120.dp)) {
                        drawCircle(
                            color = ringColor,
                            style = Stroke(width = 2.dp.toPx()),
                        )
                    }
                }
            }

            val letter = monogram.firstOrNull()?.uppercaseChar()?.toString() ?: "P"
            Text(
                text = letter,
                style = typography.callDisplay,
                color = colors.inkSecondary,
            )
        }

        when (state) {
            is AvatarRingState.Connecting -> {
                Text(
                    text = state.phaseLabel,
                    style = typography.labelMedium,
                    color = colors.indigo,
                    textAlign = TextAlign.Center,
                )
            }
            is AvatarRingState.Active -> {
                Text(
                    text = formatDuration(state.durationSeconds),
                    style = typography.mono14,
                    color = colors.active,
                    textAlign = TextAlign.Center,
                )
            }
            AvatarRingState.EndedOk -> Unit
            is AvatarRingState.EndedError -> {
                Text(
                    text = state.reason,
                    style = typography.bodySmall,
                    color = colors.danger,
                    textAlign = TextAlign.Center,
                )
            }
        }

        if (isMuted) {
            Icon(
                painter = painterResource(R.drawable.ic_mic_off),
                contentDescription = "Muted",
                tint = colors.warning,
                modifier = Modifier.size(12.dp),
            )
        }
    }
}

private fun formatDuration(seconds: Long): String {
    val safe = if (seconds < 0) 0L else seconds
    val m = safe / 60
    val s = safe % 60
    return "%02d:%02d".format(m, s)
}
