package com.pimote.android.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.pimote.android.ui.theme.PimoteTheme

data class EmptyStateCta(val label: String, val onClick: () -> Unit)

/**
 * Full-screen centered empty / loading / error state. Caller supplies an icon
 * painter, primary + secondary text, and an optional CTA. When [iconAnimating]
 * is true the icon rotates continuously (1200ms linear, e.g. for the Connecting
 * sync icon).
 */
@Composable
fun EmptyState(
    icon: Painter,
    primary: String,
    secondary: String,
    cta: EmptyStateCta? = null,
    iconAnimating: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val colors = PimoteTheme.colors
    val typography = PimoteTheme.typography
    val spacing = PimoteTheme.spacing

    Box(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = spacing.ml),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            val rotationModifier = if (iconAnimating) {
                val transition = rememberInfiniteTransition(label = "empty-state-icon")
                val rotation by transition.animateFloat(
                    initialValue = 0f,
                    targetValue = 360f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(durationMillis = 1200, easing = LinearEasing),
                    ),
                    label = "empty-state-rotation",
                )
                Modifier.graphicsLayer { rotationZ = rotation }
            } else {
                Modifier
            }

            Image(
                painter = icon,
                contentDescription = null,
                modifier = Modifier
                    .size(48.dp)
                    .then(rotationModifier),
                colorFilter = ColorFilter.tint(colors.idle),
            )

            Spacer(Modifier.height(spacing.xs))

            Text(
                text = primary,
                style = typography.bodyLarge,
                color = colors.ink,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(spacing.s))

            Text(
                text = secondary,
                style = typography.bodyMedium,
                color = colors.inkSecondary,
                textAlign = TextAlign.Center,
            )

            if (cta != null) {
                Spacer(Modifier.height(spacing.m))
                PimoteButton(
                    label = cta.label,
                    onClick = cta.onClick,
                    variant = PimoteButtonVariant.Secondary,
                )
            }
        }
    }
}
