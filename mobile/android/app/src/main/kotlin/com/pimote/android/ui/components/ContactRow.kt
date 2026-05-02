package com.pimote.android.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.pimote.android.R
import com.pimote.android.ui.theme.PimoteTheme

enum class ContactKind { Project, Session }

@Composable
fun ContactRow(
    title: String,
    subtitle: String,
    kind: ContactKind,
    isLoading: Boolean = false,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    // 100ms background flash to surfacePlus on press, fading back when released.
    val flashColor by animateColorAsState(
        targetValue = if (pressed) PimoteTheme.colors.surfacePlus else Color.Transparent,
        animationSpec = tween(durationMillis = 100),
        label = "contact-row-flash",
    )
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(flashColor)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onTap,
            )
            .heightIn(min = 72.dp)
            .padding(
                horizontal = PimoteTheme.spacing.ml,
                vertical = PimoteTheme.spacing.m,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(PimoteTheme.spacing.sm),
    ) {
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                color = PimoteTheme.colors.indigo,
                strokeWidth = 2.dp,
            )
        } else {
            val iconRes = when (kind) {
                ContactKind.Project -> R.drawable.ic_folder_outlined
                ContactKind.Session -> R.drawable.ic_chat_bubble_outlined
            }
            Icon(
                painter = painterResource(iconRes),
                contentDescription = null,
                tint = PimoteTheme.colors.indigo,
                modifier = Modifier.size(24.dp),
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = PimoteTheme.typography.titleMedium,
                color = PimoteTheme.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                style = PimoteTheme.typography.bodySmall,
                color = PimoteTheme.colors.inkSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = PimoteTheme.colors.inkSecondary,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Preview
@Composable
private fun ContactRowPreviewProject() {
    PimoteTheme {
        ContactRow(
            title = "pimote-web",
            subtitle = "New session in this project",
            kind = ContactKind.Project,
            onTap = {},
        )
    }
}

@Preview
@Composable
private fun ContactRowPreviewSession() {
    PimoteTheme {
        ContactRow(
            title = "Refactor signaling",
            subtitle = "Tap to call this session",
            kind = ContactKind.Session,
            onTap = {},
        )
    }
}

@Preview
@Composable
private fun ContactRowPreviewLoading() {
    PimoteTheme {
        ContactRow(
            title = "Connecting…",
            subtitle = "Tap to call this session",
            kind = ContactKind.Session,
            isLoading = true,
            onTap = {},
        )
    }
}
