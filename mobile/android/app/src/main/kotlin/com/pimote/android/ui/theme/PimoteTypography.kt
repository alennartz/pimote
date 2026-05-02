package com.pimote.android.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * Pimote type scale. Font families default to FontFamily.Default in this data class —
 * PimoteTheme rebuilds the typography with Inter/JetBrains Mono families wired in.
 */
@Immutable
data class PimoteTypography(
    val callDisplay: TextStyle,  // 32sp/40sp Inter 400, tracking -0.5
    val titleLarge: TextStyle,   // 22sp/28sp Inter 600
    val titleMedium: TextStyle,  // 18sp/24sp Inter 600
    val bodyLarge: TextStyle,    // 16sp/24sp Inter 400
    val bodyMedium: TextStyle,   // 14sp/20sp Inter 400
    val bodySmall: TextStyle,    // 12sp/16sp Inter 400
    val labelMedium: TextStyle,  // 12sp/16sp Inter 600, tracking 0.4
    val mono14: TextStyle,       // 14sp/20sp JetBrains Mono 400
    val mono12: TextStyle,       // 12sp/16sp JetBrains Mono 400
)

/**
 * Default typography uses [FontFamily.Default]; PimoteTheme overrides each style with
 * the actual Inter / JetBrains Mono families loaded from R.font.
 */
fun defaultPimoteTypography(
    interFamily: FontFamily = FontFamily.Default,
    monoFamily: FontFamily = FontFamily.Monospace,
): PimoteTypography = PimoteTypography(
    callDisplay = TextStyle(
        fontFamily = interFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 32.sp,
        lineHeight = 40.sp,
        letterSpacing = (-0.5).sp,
    ),
    titleLarge = TextStyle(
        fontFamily = interFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = interFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 18.sp,
        lineHeight = 24.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = interFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = interFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    bodySmall = TextStyle(
        fontFamily = interFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = interFamily,
        fontWeight = FontWeight.SemiBold,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.4.sp,
    ),
    mono14 = TextStyle(
        fontFamily = monoFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    mono12 = TextStyle(
        fontFamily = monoFamily,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    ),
)
