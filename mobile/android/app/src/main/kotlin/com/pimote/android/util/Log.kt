package com.pimote.android.util

import android.util.Log

/**
 * Tiny logging facade so logcat output is consistent and greppable.
 *
 *     adb logcat -s Pimote:* PimoteWS:* PimoteCall:* PimoteSession:* PimoteTel:*
 *
 * All Pimote tags share the `Pimote` prefix so a single `Pimote.*` filter
 * captures everything.
 */
object L {
    private const val ROOT = "Pimote"

    fun d(component: String? = null, message: String) {
        Log.d(tag(component), message)
    }

    fun i(component: String? = null, message: String) {
        Log.i(tag(component), message)
    }

    fun w(component: String? = null, message: String, t: Throwable? = null) {
        if (t != null) Log.w(tag(component), message, t) else Log.w(tag(component), message)
    }

    fun e(component: String? = null, message: String, t: Throwable? = null) {
        if (t != null) Log.e(tag(component), message, t) else Log.e(tag(component), message)
    }

    private fun tag(component: String?): String =
        if (component.isNullOrBlank()) ROOT else "$ROOT$component"
}
