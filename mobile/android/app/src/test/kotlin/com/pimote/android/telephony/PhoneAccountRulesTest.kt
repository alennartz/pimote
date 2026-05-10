package com.pimote.android.telephony

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for [PhoneAccountRules] — the sanitization, label
 * disambiguation, source-id encoding, and dial-URI parsing logic shared by
 * the contacts sync layer and the Telecom outgoing-call dispatch path.
 */
class PhoneAccountRulesTest {

    // ---------------------------------------------------------------- sanitize

    @Test
    fun `sanitize trims leading and trailing whitespace`() {
        assertEquals("hi", PhoneAccountRules.sanitize("   hi   "))
    }

    @Test
    fun `sanitize replaces control characters with single space`() {
        assertEquals("a b", PhoneAccountRules.sanitize("a\u0001b"))
    }

    @Test
    fun `sanitize collapses runs of whitespace to one space`() {
        assertEquals("a b c", PhoneAccountRules.sanitize("a   b\t\tc"))
    }

    @Test
    fun `sanitize truncates to 50 graphemes`() {
        val raw = "x".repeat(120)
        val out = PhoneAccountRules.sanitize(raw)
        assertNotNull(out)
        assertEquals(50, out!!.length)
    }

    @Test
    fun `sanitize counts emoji as a single grapheme when truncating`() {
        val raw = "\uD83D\uDC4D".repeat(60)
        val out = PhoneAccountRules.sanitize(raw)
        assertNotNull(out)
        assertEquals(100, out!!.length)
    }

    @Test
    fun `sanitize returns null for empty after trimming`() {
        assertNull(PhoneAccountRules.sanitize("    "))
        assertNull(PhoneAccountRules.sanitize(""))
        assertNull(PhoneAccountRules.sanitize("\u0000\u0001\u0002"))
    }

    // ----------------------------------------------- disambiguateFolderLabels

    @Test
    fun `non-colliding paths use just the basename`() {
        val out = PhoneAccountRules.disambiguateFolderLabels(listOf("/work/repo", "/somewhere/other"))
        assertEquals("repo", out["/work/repo"])
        assertEquals("other", out["/somewhere/other"])
    }

    @Test
    fun `colliding basenames walk up one segment`() {
        val out = PhoneAccountRules.disambiguateFolderLabels(listOf("/work/repo", "/personal/repo"))
        assertEquals("work/repo", out["/work/repo"])
        assertEquals("personal/repo", out["/personal/repo"])
    }

    @Test
    fun `three-way collision walks up enough segments to disambiguate`() {
        val out = PhoneAccountRules.disambiguateFolderLabels(
            listOf("/a/x/repo", "/b/x/repo", "/c/y/repo"),
        )
        assertTrue(out.values.toSet().size == 3, "labels not unique: $out")
    }

    @Test
    fun `non-colliding paths stay as basename even when others collide`() {
        val out = PhoneAccountRules.disambiguateFolderLabels(
            listOf("/work/repo", "/personal/repo", "/lone"),
        )
        assertEquals("lone", out["/lone"])
    }

    // ------------------------------------------------- source-id encoding

    @Test
    fun `sessionHandleId is session colon id`() {
        assertEquals("session:abc-123", PhoneAccountRules.sessionHandleId("abc-123"))
    }

    @Test
    fun `projectHandleId base64url-encodes the path`() {
        val id = PhoneAccountRules.projectHandleId("/work/repo")
        assertTrue(id.startsWith("project:"))
        val payload = id.removePrefix("project:")
        assertFalse(payload.contains('+'))
        assertFalse(payload.contains('/'))
        assertFalse(payload.contains('='))
    }

    @Test
    fun `projectHandleId is stable for same input`() {
        assertEquals(
            PhoneAccountRules.projectHandleId("/work/repo"),
            PhoneAccountRules.projectHandleId("/work/repo"),
        )
    }

    @Test
    fun `projectHandleId is distinct for different paths`() {
        val a = PhoneAccountRules.projectHandleId("/work/repo")
        val b = PhoneAccountRules.projectHandleId("/personal/repo")
        assertTrue(a != b)
    }

    // ----------------------------------------------------------- parseDialUri

    @Test
    fun `parseDialUri decodes a session URI`() {
        val parsed = PhoneAccountRules.parseDialUri("pimote:session:abc-123")
        assertEquals(PhoneAccountRules.ParsedDial.Session("abc-123"), parsed)
    }

    @Test
    fun `parseDialUri decodes a percent-encoded session URI`() {
        // Regression: TelecomManager round-trips outgoing-call URIs through
        // android.net.Uri, which percent-encodes ':' in the scheme-specific-part
        // (see Uri.fromParts). The URI delivered to ConnectionService can therefore
        // arrive as `pimote:session%3A<id>` even though we originally constructed
        // it as `pimote:session:<id>`. The parser must accept both.
        val parsed = PhoneAccountRules.parseDialUri("pimote:session%3Aabc-123")
        assertEquals(PhoneAccountRules.ParsedDial.Session("abc-123"), parsed)
    }

    @Test
    fun `parseDialUri decodes a project URI roundtripped through projectHandleId`() {
        val sourceId = PhoneAccountRules.projectHandleId("/work/repo")
        val parsed = PhoneAccountRules.parseDialUri("pimote:$sourceId")
        assertEquals(PhoneAccountRules.ParsedDial.Project("/work/repo"), parsed)
    }

    @Test
    fun `parseDialUri returns null for unknown scheme`() {
        assertNull(PhoneAccountRules.parseDialUri("tel:+15551234"))
        assertNull(PhoneAccountRules.parseDialUri("session:abc"))  // no scheme
    }

    @Test
    fun `parseDialUri returns null for unknown subtype`() {
        assertNull(PhoneAccountRules.parseDialUri("pimote:contact:abc"))
    }

    @Test
    fun `parseDialUri returns null for empty session id`() {
        assertNull(PhoneAccountRules.parseDialUri("pimote:session:"))
    }

    @Test
    fun `parseDialUri returns null for malformed base64 in project URI`() {
        assertNull(PhoneAccountRules.parseDialUri("pimote:project:!!!not-base64!!!"))
    }

    // ---------------------------------------------------------- rootSegmentOf

    @Test
    fun `rootSegmentOf returns parent's last segment for absolute path`() {
        assertEquals("repos", PhoneAccountRules.rootSegmentOf("/Users/alenna/repos/pimote"))
    }

    @Test
    fun `rootSegmentOf returns first segment when the parent is a single segment`() {
        assertEquals("repos", PhoneAccountRules.rootSegmentOf("/repos/pimote"))
    }

    @Test
    fun `rootSegmentOf returns null when the parent has no segment`() {
        assertNull(PhoneAccountRules.rootSegmentOf("/pimote"))
    }

    @Test
    fun `rootSegmentOf returns null when the input has no parent`() {
        assertNull(PhoneAccountRules.rootSegmentOf("pimote"))
    }

    @Test
    fun `rootSegmentOf returns null for empty string`() {
        assertNull(PhoneAccountRules.rootSegmentOf(""))
    }
}
