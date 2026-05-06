package com.pimote.android.session

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for the [sessionDisplayName], [shortenCwd],
 * [cwdLabelFor], and [formatRelativeTime] helpers. Mirrors the PWA's
 * `SessionItem.svelte` and `format-relative-time.ts` so the Android
 * in-app contacts screen reads the same way.
 */
class SessionDisplayTest {

    private fun meta(
        sessionId: String = "abcdef0123456789",
        name: String? = null,
        firstMessage: String? = null,
        cwd: String? = null,
        folderPath: String = "/work/repo",
    ) = SessionMeta(
        sessionId = sessionId,
        folderPath = folderPath,
        folderName = "repo",
        name = name,
        archived = false,
        modified = "2026-04-05T10:00:00.000Z",
        created = "2026-04-05T10:00:00.000Z",
        messageCount = 1,
        firstMessage = firstMessage,
        cwd = cwd,
    )

    // ------------------------------------------------ sessionDisplayName

    @Test
    fun `display name uses name when non-blank`() {
        assertEquals("feature-x", sessionDisplayName(meta(name = "feature-x")))
    }

    @Test
    fun `display name skips blank name and falls back to firstMessage`() {
        assertEquals("kick the tires", sessionDisplayName(meta(name = "   ", firstMessage = "kick the tires")))
    }

    @Test
    fun `display name truncates firstMessage longer than 60 chars`() {
        val long = "a".repeat(80)
        val out = sessionDisplayName(meta(firstMessage = long))
        assertEquals(61, out.length)         // 60 chars + ellipsis
        assertTrue(out.endsWith("…"))
        assertTrue(out.startsWith("a".repeat(60)))
    }

    @Test
    fun `display name keeps firstMessage exactly 60 chars verbatim`() {
        val sixty = "a".repeat(60)
        assertEquals(sixty, sessionDisplayName(meta(firstMessage = sixty)))
    }

    @Test
    fun `display name falls back to Session prefix when name and firstMessage absent`() {
        assertEquals("Session abcdef01", sessionDisplayName(meta(sessionId = "abcdef0123456789")))
    }

    @Test
    fun `display name handles short sessionId`() {
        assertEquals("Session ab", sessionDisplayName(meta(sessionId = "ab")))
    }

    // -------------------------------------------------------- shortenCwd

    @Test
    fun `shortenCwd returns input unchanged for short paths`() {
        assertEquals("/foo", shortenCwd("/foo"))
        assertEquals("/foo/bar", shortenCwd("/foo/bar"))
        assertEquals("foo/bar", shortenCwd("foo/bar"))
    }

    @Test
    fun `shortenCwd shows last two segments with ellipsis prefix`() {
        assertEquals("…/baz/qux", shortenCwd("/foo/bar/baz/qux"))
        assertEquals("…/y/z", shortenCwd("/a/b/c/x/y/z"))
    }

    @Test
    fun `shortenCwd tolerates trailing and consecutive slashes`() {
        assertEquals("…/baz/qux", shortenCwd("/foo//bar/baz/qux/"))
    }

    @Test
    fun `shortenCwd handles empty input`() {
        assertEquals("", shortenCwd(""))
    }

    // -------------------------------------------------------- cwdLabelFor

    @Test
    fun `cwdLabelFor returns null when cwd is null`() {
        assertNull(cwdLabelFor(meta(cwd = null), "/work/repo"))
    }

    @Test
    fun `cwdLabelFor returns null when cwd is blank`() {
        assertNull(cwdLabelFor(meta(cwd = "   "), "/work/repo"))
    }

    @Test
    fun `cwdLabelFor returns null when cwd equals folderPath`() {
        assertNull(cwdLabelFor(meta(cwd = "/work/repo"), "/work/repo"))
    }

    @Test
    fun `cwdLabelFor returns shortened cwd when distinct from folderPath`() {
        assertEquals(
            "…/repo/sub",
            cwdLabelFor(meta(cwd = "/work/repo/sub"), "/work/repo"),
        )
    }

    @Test
    fun `cwdLabelFor returns input unchanged when cwd is short and distinct`() {
        assertEquals("/other", cwdLabelFor(meta(cwd = "/other"), "/work/repo"))
    }

    // -------------------------------------------------- formatRelativeTime

    private val now = 1_712_400_000_000L  // arbitrary fixed "now"

    private fun isoBefore(seconds: Long): String =
        java.time.Instant.ofEpochMilli(now - seconds * 1000).toString()

    @Test
    fun `formatRelativeTime returns 'just now' for under 60 seconds`() {
        assertEquals("just now", formatRelativeTime(isoBefore(0), now))
        assertEquals("just now", formatRelativeTime(isoBefore(59), now))
    }

    @Test
    fun `formatRelativeTime returns minutes for under 60 minutes`() {
        assertEquals("1m ago",  formatRelativeTime(isoBefore(60), now))
        assertEquals("59m ago", formatRelativeTime(isoBefore(59 * 60), now))
    }

    @Test
    fun `formatRelativeTime returns hours for under 24 hours`() {
        assertEquals("1h ago",  formatRelativeTime(isoBefore(60 * 60), now))
        assertEquals("23h ago", formatRelativeTime(isoBefore(23 * 60 * 60), now))
    }

    @Test
    fun `formatRelativeTime returns days for under 30 days`() {
        assertEquals("1d ago",  formatRelativeTime(isoBefore(24 * 60 * 60), now))
        assertEquals("29d ago", formatRelativeTime(isoBefore(29L * 24 * 60 * 60), now))
    }

    @Test
    fun `formatRelativeTime falls through to absolute date past 30 days`() {
        val out = formatRelativeTime(isoBefore(60L * 24 * 60 * 60), now)
        assertTrue(out != "just now" && !out.endsWith("d ago"))
        assertTrue(out.isNotBlank())
    }

    @Test
    fun `formatRelativeTime treats negative skew as just now`() {
        assertEquals("just now", formatRelativeTime(isoBefore(-30), now))
    }

    @Test
    fun `formatRelativeTime returns input verbatim for unparseable timestamps`() {
        assertEquals("not a timestamp", formatRelativeTime("not a timestamp", now))
    }
}
