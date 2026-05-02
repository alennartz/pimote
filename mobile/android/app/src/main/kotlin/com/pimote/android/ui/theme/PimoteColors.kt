package com.pimote.android.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * Pimote palette tokens. All values from `docs/designs/android-app.md`.
 * Dark-only — light theme is out of scope for the v1 redesign.
 */
@Immutable
data class PimoteColors(
    val void: Color,           // #0D0F14 — primary background
    val surface: Color,        // #161922 — elevated surface
    val surfacePlus: Color,    // #1E222E — tertiary surface
    val scrim: Color,          // rgba(0,0,0,0.6)
    val ink: Color,            // #E4E8F2 — primary text
    val inkSecondary: Color,   // #7D8699
    val inkDisabled: Color,    // #3D4252
    val line: Color,           // #252934
    val indigo: Color,         // #7B9FFF — interactive accent
    val active: Color,         // #4DC896 — connected/alive
    val warning: Color,        // #F0B34C
    val danger: Color,         // #F26B6B
    val idle: Color,           // #5A6070
)

val DefaultPimoteColors = PimoteColors(
    void = Color(0xFF0D0F14),
    surface = Color(0xFF161922),
    surfacePlus = Color(0xFF1E222E),
    scrim = Color(0x99000000), // rgba(0,0,0,0.6)
    ink = Color(0xFFE4E8F2),
    inkSecondary = Color(0xFF7D8699),
    inkDisabled = Color(0xFF3D4252),
    line = Color(0xFF252934),
    indigo = Color(0xFF7B9FFF),
    active = Color(0xFF4DC896),
    warning = Color(0xFFF0B34C),
    danger = Color(0xFFF26B6B),
    idle = Color(0xFF5A6070),
)
