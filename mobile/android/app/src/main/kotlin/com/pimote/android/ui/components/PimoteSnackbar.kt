package com.pimote.android.ui.components

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.pimote.android.R
import com.pimote.android.ui.theme.PimoteTheme

enum class PimoteSnackbarVariant { Error, Info }

@Composable
fun PimoteSnackbarHost(
    hostState: SnackbarHostState,
    variant: PimoteSnackbarVariant = PimoteSnackbarVariant.Info,
    modifier: Modifier = Modifier,
) {
    val colors = PimoteTheme.colors
    val shape = RoundedCornerShape(12.dp)
    SnackbarHost(
        hostState = hostState,
        modifier = modifier.padding(16.dp),
    ) { data ->
        Snackbar(
            shape = shape,
            containerColor = colors.surfacePlus,
            contentColor = colors.ink,
            modifier = Modifier
                .heightIn(min = 52.dp)
                .border(1.dp, colors.line, shape),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (variant == PimoteSnackbarVariant.Error) {
                    Icon(
                        painter = painterResource(R.drawable.ic_error_outline),
                        contentDescription = null,
                        tint = colors.danger,
                        modifier = Modifier.size(16.dp),
                    )
                }
                Text(text = data.visuals.message, style = PimoteTheme.typography.bodyMedium)
            }
        }
    }
}

@Preview
@Composable
private fun PimoteSnackbarPreviewInfo() {
    PimoteTheme {
        val state = remember { SnackbarHostState() }
        LaunchedEffect(Unit) { state.showSnackbar("Settings saved") }
        PimoteSnackbarHost(state, variant = PimoteSnackbarVariant.Info)
    }
}

@Preview
@Composable
private fun PimoteSnackbarPreviewError() {
    PimoteTheme {
        val state = remember { SnackbarHostState() }
        LaunchedEffect(Unit) { state.showSnackbar("Connect failed: invalid URL") }
        PimoteSnackbarHost(state, variant = PimoteSnackbarVariant.Error)
    }
}
