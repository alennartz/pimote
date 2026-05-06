package com.pimote.android.ui.contacts

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pimote.android.R
import com.pimote.android.ui.theme.PimoteTheme

/**
 * Section header for a project group. Visually distinct from session rows:
 *
 * - shorter overall height (no avatar, no chevron),
 * - distinct background tint (`surfacePlus`),
 * - bold uppercase label,
 * - thin top divider (caller is responsible for omitting it on the very
 *   first header).
 *
 * The header itself is NOT tappable; the inline phone IconButton on the
 * right is the explicit "call this project" action so the row reads as a
 * section title rather than a contact entry.
 */
@Composable
fun ProjectHeaderRow(
    label: String,
    isLoading: Boolean,
    showTopDivider: Boolean,
    onCallProject: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        if (showTopDivider) {
            HorizontalDivider(
                color = PimoteTheme.colors.line,
                thickness = 1.dp,
            )
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(PimoteTheme.colors.surfacePlus)
                .heightIn(min = 40.dp)
                .padding(
                    start = PimoteTheme.spacing.ml,
                    end = PimoteTheme.spacing.s,
                    top = PimoteTheme.spacing.s,
                    bottom = PimoteTheme.spacing.s,
                ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(PimoteTheme.spacing.sm),
        ) {
            Text(
                text = label.uppercase(),
                style = PimoteTheme.typography.labelMedium.copy(
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.8.sp,
                ),
                color = PimoteTheme.colors.inkSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (isLoading) {
                Box(modifier = Modifier.size(36.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        color = PimoteTheme.colors.indigo,
                        strokeWidth = 2.dp,
                    )
                }
            } else {
                IconButton(onClick = onCallProject, modifier = Modifier.size(36.dp)) {
                    Icon(
                        painter = painterResource(R.drawable.ic_call_outlined),
                        contentDescription = "Call $label",
                        tint = PimoteTheme.colors.indigo,
                    )
                }
            }
        }
    }
}

/**
 * Indented session row inside a project group.
 *
 * Layout (PWA parity):
 *   - line 1: display name (bigger / bolder than the metadata)
 *   - line 2 (optional): cwd hint, italic + muted, only when distinct from
 *     the project folder
 *   - line 3: "<n> msgs · <relative time>" — the user's primary scan signal
 *
 * Indented from the screen edge by `spacing.ml` so it nests visually under
 * the project header. Press-flash + chevron preserved from the original
 * ContactRow styling.
 */
@Composable
fun SessionListRow(
    title: String,
    cwdLabel: String?,
    metadataLine: String,
    isLoading: Boolean,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val interactionSource = remember { MutableInteractionSource() }
    val pressed by interactionSource.collectIsPressedAsState()
    val flashColor by animateColorAsState(
        targetValue = if (pressed) PimoteTheme.colors.surfacePlus else Color.Transparent,
        animationSpec = tween(durationMillis = 100),
        label = "session-row-flash",
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
            .heightIn(min = 64.dp)
            .padding(
                start = PimoteTheme.spacing.ml + PimoteTheme.spacing.ml,  // indent under header
                end = PimoteTheme.spacing.ml,
                top = PimoteTheme.spacing.s,
                bottom = PimoteTheme.spacing.s,
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
            Icon(
                painter = painterResource(R.drawable.ic_chat_bubble_outlined),
                contentDescription = null,
                tint = PimoteTheme.colors.inkSecondary,
                modifier = Modifier.size(18.dp),
            )
        }

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = PimoteTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
                color = PimoteTheme.colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (cwdLabel != null) {
                Text(
                    text = cwdLabel,
                    style = PimoteTheme.typography.bodySmall.copy(
                        fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                    ),
                    color = PimoteTheme.colors.inkSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                text = metadataLine,
                style = PimoteTheme.typography.bodySmall,
                color = PimoteTheme.colors.inkSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = PimoteTheme.colors.inkDisabled,
            modifier = Modifier.size(20.dp),
        )
    }
}
