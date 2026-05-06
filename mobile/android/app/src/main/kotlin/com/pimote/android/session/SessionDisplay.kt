package com.pimote.android.session

/**
 * Pure presentation helpers for the in-app contacts screen. Mirrors the
 * display logic in `client/src/lib/components/SessionItem.svelte` and
 * `client/src/lib/format-relative-time.ts`.
 *
 * Implementations pending — see plan
 * `docs/plans/android-contacts-screen-pwa-parity.md`.
 */

/**
 * User-visible name for a session. Fallback chain:
 *   1. `name` if non-blank.
 *   2. `firstMessage` truncated to 60 chars (with a trailing `…`
 *      when truncation occurred).
 *   3. `"Session <first 8 chars of sessionId>"`.
 */
fun sessionDisplayName(session: SessionMeta): String =
    TODO("Implemented in implementing phase")

/**
 * Shorten a working-directory path for inline display.
 *
 * - 0–2 non-empty segments ⇒ returns the input unchanged.
 * - 3+ non-empty segments ⇒ returns `"…/" + lastTwoSegments.joinToString("/")`.
 *
 * Trailing slashes and consecutive slashes are tolerated and collapsed.
 */
fun shortenCwd(cwd: String): String =
    TODO("Implemented in implementing phase")

/**
 * Returns the cwd label for a session if and only if `session.cwd` is
 * non-null, non-blank, and not equal to `folderPath`. Otherwise null —
 * which suppresses the row's cwd subline (PWA parity: don't repeat the
 * folder path under its own session).
 */
fun cwdLabelFor(session: SessionMeta, folderPath: String): String? =
    TODO("Implemented in implementing phase")

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
fun formatRelativeTime(isoTimestamp: String, nowMillis: Long): String =
    TODO("Implemented in implementing phase")
