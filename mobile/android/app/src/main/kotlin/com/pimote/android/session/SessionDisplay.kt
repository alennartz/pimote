package com.pimote.android.session

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * Pure presentation helpers for the in-app contacts screen. Mirrors the
 * display logic in `client/src/lib/components/SessionItem.svelte` and
 * `client/src/lib/format-relative-time.ts`.
 */

/**
 * User-visible name for a session. Fallback chain:
 *   1. `name` if non-blank.
 *   2. `firstMessage` truncated to 60 chars (with a trailing `…`
 *      when truncation occurred).
 *   3. `"Session <first 8 chars of sessionId>"`.
 */
fun sessionDisplayName(session: SessionMeta): String {
    val name = session.name
    if (!name.isNullOrBlank()) return name
    val first = session.firstMessage
    if (first != null) {
        return if (first.length > 60) first.take(60) + "…" else first
    }
    return "Session ${session.sessionId.take(8)}"
}

/**
 * Shorten a working-directory path for inline display.
 *
 * - 0–2 non-empty segments ⇒ returns the input unchanged.
 * - 3+ non-empty segments ⇒ returns `"…/" + lastTwoSegments.joinToString("/")`.
 *
 * Trailing slashes and consecutive slashes are tolerated and collapsed.
 */
fun shortenCwd(cwd: String): String {
    val segs = cwd.split('/').filter { it.isNotEmpty() }
    if (segs.size <= 2) return cwd
    return "…/" + segs.takeLast(2).joinToString("/")
}

/**
 * Returns the cwd label for a session if and only if `session.cwd` is
 * non-null, non-blank, and not equal to `folderPath`. Otherwise null —
 * which suppresses the row's cwd subline (PWA parity: don't repeat the
 * folder path under its own session).
 */
fun cwdLabelFor(session: SessionMeta, folderPath: String): String? {
    val cwd = session.cwd ?: return null
    if (cwd.isBlank()) return null
    if (cwd == folderPath) return null
    return shortenCwd(cwd)
}

private val absoluteDateFormatter: DateTimeFormatter =
    DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withZone(ZoneId.systemDefault())

/**
 * Format an ISO-8601 timestamp as a relative-time string.
 *
 * - `< 60s` since [nowMillis] ⇒ `"just now"`.
 * - `< 60m` ⇒ `"<n>m ago"`.
 * - `< 24h` ⇒ `"<n>h ago"`.
 * - `< 30d` ⇒ `"<n>d ago"`.
 * - else ⇒ a locale-formatted absolute date string.
 *
 * Negative diffs (clock skew) are treated as `"just now"`. Unparseable
 * input returns the input verbatim (best-effort fallback).
 *
 * [nowMillis] is injected rather than read from
 * `System.currentTimeMillis()` so the function is deterministic.
 */
fun formatRelativeTime(isoTimestamp: String, nowMillis: Long): String {
    val parsed = try {
        Instant.parse(isoTimestamp)
    } catch (_: Throwable) {
        return isoTimestamp
    }
    val diffMs = nowMillis - parsed.toEpochMilli()
    if (diffMs < 0) return "just now"
    val diffSec = diffMs / 1000
    val diffMin = diffSec / 60
    val diffHr = diffMin / 60
    val diffDay = diffHr / 24
    return when {
        diffSec < 60 -> "just now"
        diffMin < 60 -> "${diffMin}m ago"
        diffHr < 24 -> "${diffHr}h ago"
        diffDay < 30 -> "${diffDay}d ago"
        else -> absoluteDateFormatter.format(parsed)
    }
}
