package com.pimote.android.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.unit.dp
import com.pimote.android.ui.theme.PimoteTheme

enum class PimoteButtonVariant { Primary, Secondary, Destructive, Ghost }

private data class PimoteButtonPalette(
    val container: Color,
    val content: Color,
    val border: Color?,
)

/**
 * Pimote-themed button. Material3 [Button] under the hood with overridden colors,
 * 12dp corner radius, 52dp height, and a press scale-down animation.
 */
@Composable
fun PimoteButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: PimoteButtonVariant = PimoteButtonVariant.Primary,
    enabled: Boolean = true,
    isLoading: Boolean = false,
    leadingIcon: Painter? = null,
) {
    val colors = PimoteTheme.colors
    val typography = PimoteTheme.typography
    val spacing = PimoteTheme.spacing

    val palette = when (variant) {
        PimoteButtonVariant.Primary -> PimoteButtonPalette(
            container = colors.indigo,
            content = Color(0xFF000000),
            border = null,
        )
        PimoteButtonVariant.Secondary -> PimoteButtonPalette(
            container = colors.surfacePlus,
            content = colors.ink,
            border = colors.line,
        )
        PimoteButtonVariant.Destructive -> PimoteButtonPalette(
            container = colors.danger,
            content = Color.White,
            border = null,
        )
        PimoteButtonVariant.Ghost -> PimoteButtonPalette(
            container = Color.Transparent,
            content = colors.indigo,
            border = null,
        )
    }

    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.98f else 1f,
        animationSpec = tween(durationMillis = 100),
        label = "pimote-button-scale",
    )

    // 16% ink overlay drawn on top of the button content while pressed.
    val pressOverlay = colors.ink.copy(alpha = 0.16f)
    Button(
        onClick = onClick,
        modifier = modifier
            .height(52.dp)
            .scale(scale)
            .alpha(if (enabled) 1f else 0.38f)
            .drawWithContent {
                drawContent()
                if (pressed) drawRect(pressOverlay)
            },
        enabled = enabled && !isLoading,
        shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = palette.container,
            contentColor = palette.content,
            disabledContainerColor = palette.container,
            disabledContentColor = palette.content,
        ),
        border = palette.border?.let { BorderStroke(1.dp, it) },
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 0.dp),
        interactionSource = interactionSource,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(spacing.s),
        ) {
            // Reserve the 16dp leading slot whenever the caller might toggle
            // `isLoading`, so the button width stays stable across the toggle.
            // When neither a leading icon nor a spinner is shown, render an
            // invisible placeholder so the layout still allocates the slot.
            Box(modifier = Modifier.size(16.dp), contentAlignment = Alignment.Center) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.fillMaxSize(),
                        color = palette.content,
                        strokeWidth = 2.dp,
                    )
                } else if (leadingIcon != null) {
                    Icon(
                        painter = leadingIcon,
                        contentDescription = null,
                        tint = palette.content,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    Spacer(modifier = Modifier.fillMaxSize())
                }
            }
            Text(text = label, style = typography.labelMedium)
        }
    }
}
