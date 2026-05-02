package com.pimote.android.contacts

import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.telephony.PhoneAccountRules
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for [ContactsSync]. Covers the desired-set derivation
 * (sanitization + disambiguation + URI encoding) and the diff that drives
 * ContactsContract batch operations.
 */
class ContactsSyncTest {

    // -------------------------------------------- computeDesiredContacts

    @Test
    fun `desired contacts include both project and session entries`() {
        val projects = listOf(ProjectMeta("/work/repo", "repo"))
        val sessions = listOf(
            SessionMeta(
                sessionId = "s1",
                folderPath = "/work/repo",
                folderName = "repo",
                name = "feature",
                archived = false,
            ),
        )
        val out = ContactsSync.computeDesiredContacts(projects, sessions)
        assertEquals(2, out.size)
    }

    @Test
    fun `session contact label is folderName slash sessionName`() {
        val projects = listOf(ProjectMeta("/work/repo", "repo"))
        val sessions = listOf(
            SessionMeta("s1", "/work/repo", "repo", "feature", false),
        )
        val out = ContactsSync.computeDesiredContacts(projects, sessions)
        val sessionContact = out.single { it.sourceId == "session:s1" }
        assertEquals("repo/feature", sessionContact.displayName)
    }

    @Test
    fun `project contact label is folderName only`() {
        val projects = listOf(ProjectMeta("/work/repo", "repo"))
        val out = ContactsSync.computeDesiredContacts(projects, emptyList())
        val projectContact = out.single()
        assertEquals("repo", projectContact.displayName)
        assertEquals(PhoneAccountRules.projectHandleId("/work/repo"), projectContact.sourceId)
    }

    @Test
    fun `pimote URI is the source-id with pimote scheme prefix`() {
        val projects = listOf(ProjectMeta("/work/repo", "repo"))
        val sessions = listOf(
            SessionMeta("s1", "/work/repo", "repo", "feature", false),
        )
        val out = ContactsSync.computeDesiredContacts(projects, sessions)
        val session = out.single { it.sourceId.startsWith("session:") }
        val project = out.single { it.sourceId.startsWith("project:") }
        assertEquals("pimote:session:s1", session.pimoteUri)
        assertEquals("pimote:${PhoneAccountRules.projectHandleId("/work/repo")}", project.pimoteUri)
    }

    @Test
    fun `colliding folders propagate disambiguated prefix to session labels`() {
        val projects = listOf(
            ProjectMeta("/work/repo", "repo"),
            ProjectMeta("/personal/repo", "repo"),
        )
        val sessions = listOf(
            SessionMeta("s1", "/work/repo", "repo", "feat", false),
        )
        val labels = ContactsSync.computeDesiredContacts(projects, sessions)
            .map { it.displayName }
            .toSet()
        assertTrue(labels.contains("work/repo"))
        assertTrue(labels.contains("personal/repo"))
        assertTrue(labels.contains("work/repo/feat"))
    }

    @Test
    fun `entries that sanitize to empty are dropped silently`() {
        val projects = listOf(ProjectMeta("/", "   "))
        val sessions = listOf(SessionMeta("s1", "/", "   ", "\u0000", false))
        val out = ContactsSync.computeDesiredContacts(projects, sessions)
        assertTrue(out.isEmpty())
    }

    @Test
    fun `null sessionName falls back to a labeled placeholder`() {
        val projects = listOf(ProjectMeta("/work/repo", "repo"))
        val sessions = listOf(SessionMeta("s1", "/work/repo", "repo", null, false))
        val out = ContactsSync.computeDesiredContacts(projects, sessions)
        val s = out.single { it.sourceId == "session:s1" }
        assertTrue(s.displayName.startsWith("repo/"))
        assertTrue(s.displayName.length > "repo/".length)
    }

    @Test
    fun `no upper bound on the desired set`() {
        // Where the old PhoneAccountRules.computeDesiredAccounts used to truncate at
        // 9 (Telecom's cap), ContactsSync must not — ContactsContract has no
        // comparable per-app limit on contact rows.
        val projects = (1..50).map { ProjectMeta("/p$it/repo", "repo$it") }
        val sessions = (1..200).map {
            SessionMeta("s$it", "/p1/repo", "repo1", "name$it", false)
        }
        val out = ContactsSync.computeDesiredContacts(projects, sessions)
        assertEquals(projects.size + sessions.size, out.size)
    }

    // -------------------------------------------------------------- diff

    @Test
    fun `diff emits inserts for source ids only in desired`() {
        val desired = listOf(
            ContactsSync.DesiredContact("session:b", "B", "pimote:session:b", "Call B"),
        )
        val existing = emptyList<ContactsSync.ExistingContact>()
        val ops = ContactsSync.diff(desired, existing)
        assertEquals(listOf("session:b"), ops.toInsert.map { it.sourceId })
        assertTrue(ops.toDelete.isEmpty())
        assertTrue(ops.toUpdate.isEmpty())
    }

    @Test
    fun `diff emits deletes for source ids only in existing`() {
        val desired = emptyList<ContactsSync.DesiredContact>()
        val existing = listOf(
            ContactsSync.ExistingContact("session:a", 42L, "A", "pimote:session:a"),
        )
        val ops = ContactsSync.diff(desired, existing)
        assertEquals(listOf(42L), ops.toDelete)
        assertTrue(ops.toInsert.isEmpty())
        assertTrue(ops.toUpdate.isEmpty())
    }

    @Test
    fun `diff emits updates when displayName changes`() {
        val desired = listOf(
            ContactsSync.DesiredContact("session:a", "New", "pimote:session:a", "Call New"),
        )
        val existing = listOf(
            ContactsSync.ExistingContact("session:a", 42L, "Old", "pimote:session:a"),
        )
        val ops = ContactsSync.diff(desired, existing)
        assertEquals(1, ops.toUpdate.size)
        assertEquals(42L, ops.toUpdate.single().rawContactId)
        assertEquals("New", ops.toUpdate.single().desired.displayName)
        assertTrue(ops.toInsert.isEmpty())
        assertTrue(ops.toDelete.isEmpty())
    }

    @Test
    fun `diff emits updates when pimoteUri changes`() {
        val desired = listOf(
            ContactsSync.DesiredContact("session:a", "A", "pimote:session:a-new", "Call A"),
        )
        val existing = listOf(
            ContactsSync.ExistingContact("session:a", 42L, "A", "pimote:session:a-old"),
        )
        val ops = ContactsSync.diff(desired, existing)
        assertEquals(1, ops.toUpdate.size)
    }

    @Test
    fun `diff is empty when desired equals existing`() {
        val desired = listOf(
            ContactsSync.DesiredContact("session:a", "A", "pimote:session:a", "Call A"),
        )
        val existing = listOf(
            ContactsSync.ExistingContact("session:a", 42L, "A", "pimote:session:a"),
        )
        val ops = ContactsSync.diff(desired, existing)
        assertTrue(ops.toInsert.isEmpty())
        assertTrue(ops.toDelete.isEmpty())
        assertTrue(ops.toUpdate.isEmpty())
    }
}
