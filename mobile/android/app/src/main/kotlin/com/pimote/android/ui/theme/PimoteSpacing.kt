package com.pimote.android.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Pimote spacing scale (4 dp baseline). */
@Immutable
data class PimoteSpacing(
    val xs: Dp,    // 4
    val s: Dp,     // 8
    val sm: Dp,    // 12
    val m: Dp,     // 16
    val ml: Dp,    // 20  (content padding)
    val l: Dp,     // 24
    val xl: Dp,    // 32
    val xxl: Dp,   // 48
    val xxxl: Dp,  // 64
)

val DefaultPimoteSpacing = PimoteSpacing(
    xs = 4.dp,
    s = 8.dp,
    sm = 12.dp,
    m = 16.dp,
    ml = 20.dp,
    l = 24.dp,
    xl = 32.dp,
    xxl = 48.dp,
    xxxl = 64.dp,
)
