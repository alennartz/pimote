package com.pimote.android.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import com.pimote.android.R

private val LocalPimoteColors = staticCompositionLocalOf<PimoteColors> {
    error("PimoteColors not provided. Wrap content in PimoteTheme { … }.")
}
private val LocalPimoteTypography = staticCompositionLocalOf<PimoteTypography> {
    error("PimoteTypography not provided. Wrap content in PimoteTheme { … }.")
}
private val LocalPimoteSpacing = staticCompositionLocalOf<PimoteSpacing> {
    error("PimoteSpacing not provided. Wrap content in PimoteTheme { … }.")
}

/** Static accessors for tokens inside a PimoteTheme tree. */
object PimoteTheme {
    val colors: PimoteColors
        @Composable get() = LocalPimoteColors.current
    val typography: PimoteTypography
        @Composable get() = LocalPimoteTypography.current
    val spacing: PimoteSpacing
        @Composable get() = LocalPimoteSpacing.current
}

private val InterFamily = FontFamily(Font(R.font.inter_variable))
private val JetBrainsMonoFamily = FontFamily(Font(R.font.jetbrainsmono_variable))

/**
 * Root theme. Wraps Material3's [MaterialTheme] (so `MaterialTheme.colorScheme.primary`
 * etc. continue to resolve cleanly) and provides the Pimote-specific tokens via
 * [CompositionLocalProvider]. Dark-only.
 */
@Composable
fun PimoteTheme(content: @Composable () -> Unit) {
    val colors = DefaultPimoteColors
    val typography = defaultPimoteTypography(
        interFamily = InterFamily,
        monoFamily = JetBrainsMonoFamily,
    )
    val spacing = DefaultPimoteSpacing

    val materialColorScheme = darkColorScheme(
        primary = colors.indigo,
        onPrimary = colors.void,
        error = colors.danger,
        onError = colors.ink,
        background = colors.void,
        onBackground = colors.ink,
        surface = colors.surface,
        onSurface = colors.ink,
        surfaceVariant = colors.surfacePlus,
        onSurfaceVariant = colors.inkSecondary,
        outline = colors.line,
    )

    val materialTypography = Typography(
        displayLarge = typography.callDisplay,
        displayMedium = typography.callDisplay,
        displaySmall = typography.titleLarge,
        headlineLarge = typography.titleLarge,
        headlineMedium = typography.titleLarge,
        headlineSmall = typography.titleMedium,
        titleLarge = typography.titleLarge,
        titleMedium = typography.titleMedium,
        titleSmall = typography.titleMedium,
        bodyLarge = typography.bodyLarge,
        bodyMedium = typography.bodyMedium,
        bodySmall = typography.bodySmall,
        labelLarge = typography.labelMedium,
        labelMedium = typography.labelMedium,
        labelSmall = typography.labelMedium,
    )

    CompositionLocalProvider(
        LocalPimoteColors provides colors,
        LocalPimoteTypography provides typography,
        LocalPimoteSpacing provides spacing,
    ) {
        MaterialTheme(
            colorScheme = materialColorScheme,
            typography = materialTypography,
            content = content,
        )
    }
}
