package com.pimote.android.telephony

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for [PhoneAccountRules] — the sanitization, disambiguation,
 * desired-account derivation, and reconcile-diff logic that backs
 * [PhoneAccountRegistrar]. No Telecom framework dependency.
 */
class PhoneAccountRulesTest {

    // ---------------------------------------------------------------- sanitize

    @Test
    fun `sanitize trims leading and trailing whitespace`() {
        assertEquals("hi", PhoneAccountRules.sanitize("   hi   "))
    }

    @Test
    fun `sanitize replaces control characters with single space`() {
        // \u0001 between letters → single space.
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
        // 60 thumbs-up emoji (each is a grapheme cluster, multi-codepoint).
        val raw = "\uD83D\uDC4D".repeat(60)
        val out = PhoneAccountRules.sanitize(raw)
        assertNotNull(out)
        // Truncated to 50 graphemes → 100 UTF-16 code units (each emoji is a surrogate pair).
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

    // ------------------------------------------------- handleId encoding

    @Test
    fun `sessionHandleId is session colon id`() {
        assertEquals("session:abc-123", PhoneAccountRules.sessionHandleId("abc-123"))
    }

    @Test
    fun `projectHandleId base64url-encodes the path`() {
        val id = PhoneAccountRules.projectHandleId("/work/repo")
        assertTrue(id.startsWith("project:"))
        // base64url alphabet only — no '+', '/', or '=' padding.
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

    // ----------------------------------------------- computeDesiredAccounts

    @Test
    fun `desired accounts include both project and per-session entries`() {
        val projects = listOf(PhoneAccountRules.ProjectInput("/work/repo", "repo"))
        val sessions = listOf(
            PhoneAccountRules.SessionInput("s1", "/work/repo", "repo", "feature"),
        )
        val out = PhoneAccountRules.computeDesiredAccounts(projects, sessions)
        // One project handle + one session handle.
        assertEquals(2, out.size)
        val byKind = out.values.groupBy { it.kind::class.simpleName }
        assertNotNull(byKind["Project"])
        assertNotNull(byKind["Session"])
    }

    @Test
    fun `session label uses folderName slash sessionName`() {
        val projects = listOf(PhoneAccountRules.ProjectInput("/work/repo", "repo"))
        val sessions = listOf(
            PhoneAccountRules.SessionInput("s1", "/work/repo", "repo", "feature"),
        )
        val desired = PhoneAccountRules.computeDesiredAccounts(projects, sessions).values
            .single { it.kind is AccountKind.Session }
        assertEquals("repo/feature", desired.label)
    }

    @Test
    fun `project label uses folderName only`() {
        val projects = listOf(PhoneAccountRules.ProjectInput("/work/repo", "repo"))
        val desired = PhoneAccountRules.computeDesiredAccounts(projects, emptyList()).values.single()
        assertEquals("repo", desired.label)
        assertEquals(AccountKind.Project::class, desired.kind::class)
    }

    @Test
    fun `colliding folders propagate disambiguated prefix to session labels`() {
        val projects = listOf(
            PhoneAccountRules.ProjectInput("/work/repo", "repo"),
            PhoneAccountRules.ProjectInput("/personal/repo", "repo"),
        )
        val sessions = listOf(
            PhoneAccountRules.SessionInput("s1", "/work/repo", "repo", "feat"),
        )
        val labels = PhoneAccountRules.computeDesiredAccounts(projects, sessions).values
            .map { it.label }
            .toSet()
        assertTrue(labels.contains("work/repo"))
        assertTrue(labels.contains("personal/repo"))
        assertTrue(labels.contains("work/repo/feat"))
    }

    @Test
    fun `entries that sanitize to empty are dropped silently`() {
        val projects = listOf(PhoneAccountRules.ProjectInput("/", "   "))
        val sessions = listOf(
            PhoneAccountRules.SessionInput("s1", "/", "   ", "\u0000"),
        )
        val out = PhoneAccountRules.computeDesiredAccounts(projects, sessions)
        assertTrue(out.isEmpty())
    }

    @Test
    fun `null sessionName falls back to a stable placeholder`() {
        val projects = listOf(PhoneAccountRules.ProjectInput("/work/repo", "repo"))
        val sessions = listOf(
            PhoneAccountRules.SessionInput("s1", "/work/repo", "repo", null),
        )
        // Implementation may pick any non-empty sanitized fallback (e.g. session id,
        // "untitled", etc) — just assert the session is present and labeled.
        val s = PhoneAccountRules.computeDesiredAccounts(projects, sessions).values
            .single { it.kind is AccountKind.Session }
        assertTrue(s.label.startsWith("repo/"))
        assertTrue(s.label.length > "repo/".length)
    }

    // ----------------------------------------------------------- diff

    @Test
    fun `diff emits adds for handles only in desired`() {
        val out = PhoneAccountRules.diff(
            current = mapOf("session:a" to "A"),
            desired = mapOf("session:a" to "A", "session:b" to "B"),
        )
        assertEquals(listOf("session:b"), out.toRegister)
        assertTrue(out.toUnregister.isEmpty())
        assertTrue(out.toReplace.isEmpty())
    }

    @Test
    fun `diff emits removes for handles only in current`() {
        val out = PhoneAccountRules.diff(
            current = mapOf("session:a" to "A", "session:b" to "B"),
            desired = mapOf("session:a" to "A"),
        )
        assertEquals(listOf("session:b"), out.toUnregister)
        assertTrue(out.toRegister.isEmpty())
        assertTrue(out.toReplace.isEmpty())
    }

    @Test
    fun `diff emits replace for label-changed handles`() {
        val out = PhoneAccountRules.diff(
            current = mapOf("session:a" to "Old"),
            desired = mapOf("session:a" to "New"),
        )
        assertEquals(listOf("session:a"), out.toReplace)
        assertTrue(out.toRegister.isEmpty())
        assertTrue(out.toUnregister.isEmpty())
    }

    @Test
    fun `diff is empty when current equals desired`() {
        val out = PhoneAccountRules.diff(
            current = mapOf("session:a" to "A", "project:p" to "P"),
            desired = mapOf("session:a" to "A", "project:p" to "P"),
        )
        assertTrue(out.toRegister.isEmpty())
        assertTrue(out.toUnregister.isEmpty())
        assertTrue(out.toReplace.isEmpty())
    }
}
