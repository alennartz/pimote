package com.pimote.android.ui.components

private const val WS_ERROR_PREFIX = "ws error:"
private const val MAX_REASON_LEN = 40

/**
 * Cleans a raw reason string for display in the StatusPill:
 * - Strips a leading "ws error:" prefix (case-insensitive, including any single trailing space).
 * - Truncates to 40 characters, appending "…" if truncated.
 */
fun cleanStatusReason(raw: String): String {
    var s = raw
    if (s.length >= WS_ERROR_PREFIX.length &&
        s.substring(0, WS_ERROR_PREFIX.length).equals(WS_ERROR_PREFIX, ignoreCase = true)
    ) {
        s = s.substring(WS_ERROR_PREFIX.length)
        if (s.startsWith(" ")) s = s.substring(1)
    }
    return if (s.length > MAX_REASON_LEN) s.substring(0, MAX_REASON_LEN) + "…" else s
}
