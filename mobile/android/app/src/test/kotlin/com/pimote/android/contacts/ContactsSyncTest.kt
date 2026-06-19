package com.pimote.android.contacts

import com.pimote.android.session.ProjectMeta
import com.pimote.android.telephony.PhoneAccountRules
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for [ContactsSync]. Covers the desired-set derivation
 * (sanitization + disambiguation + URI encoding) and the diff that drives
 * ContactsContract batch operations.
 *
 * Sessions are intentionally NOT registered as contacts — only projects /
 * folders are. See `computeDesiredContacts` doc for rationale.
 */
class ContactsSyncTest {

    // -------------------------------------------- computeDesiredContacts

    @Test
    fun `desired contacts contain one entry per project`() {
        val projects = listOf(
            ProjectMeta("/work/repo", "repo"),
            ProjectMeta("/work/other", "other"),
        )
        val out = ContactsSync.computeDesiredContacts(projects)
        assertEquals(2, out.size)
    }

    @Test
    fun `project contact label is root folderName`() {
        // New format: "<root> <project>". Root is the parent path's last
        // segment (rootSegmentOf), project is the folder's basename.
        val projects = listOf(ProjectMeta("/work/repo", "repo"))
        val out = ContactsSync.computeDesiredContacts(projects)
        val projectContact = out.single()
        assertEquals("work repo", projectContact.displayName)
        assertEquals(PhoneAccountRules.projectHandleId("/work/repo"), projectContact.sourceId)
    }

    @Test
    fun `project contact label falls back to bare folderName when root is null`() {
        // Top-level folder: parent has no segment, so rootSegmentOf returns
            // null. Display name is the bare project name.
        val projects = listOf(ProjectMeta("/repo", "repo"))
        val out = ContactsSync.computeDesiredContacts(projects)
        assertEquals("repo", out.single().displayName)
    }

    @Test
    fun `pimote URI is the source-id with pimote scheme prefix`() {
        val projects = listOf(ProjectMeta("/work/repo", "repo"))
        val out = ContactsSync.computeDesiredContacts(projects)
        val project = out.single()
        assertEquals("pimote:${PhoneAccountRules.projectHandleId("/work/repo")}", project.pimoteUri)
    }

    @Test
    fun `colliding folder names are disambiguated by root segment prefix`() {
        // Under the new format "<root> <project>", colliding basenames
        // are naturally distinguished by their distinct root segments.
        val projects = listOf(
            ProjectMeta("/work/repo", "repo"),
            ProjectMeta("/personal/repo", "repo"),
        )
        val labels = ContactsSync.computeDesiredContacts(projects)
            .map { it.displayName }
            .toSet()
        assertTrue(labels.contains("work repo"))
        assertTrue(labels.contains("personal repo"))
    }

    @Test
    fun `entries that sanitize to empty are dropped silently`() {
        val projects = listOf(ProjectMeta("/", "   "))
        val out = ContactsSync.computeDesiredContacts(projects)
        assertTrue(out.isEmpty())
    }

    @Test
    fun `no upper bound on the desired set`() {
        // Where the old PhoneAccountRules.computeDesiredAccounts used to truncate
        // at 9 (Telecom's cap), ContactsSync must not — ContactsContract has no
        // comparable per-app limit on contact rows.
        val projects = (1..50).map { ProjectMeta("/p$it/repo", "repo$it") }
        val out = ContactsSync.computeDesiredContacts(projects)
        assertEquals(projects.size, out.size)
    }

    // -------------------------------------------------------------- diff

    @Test
    fun `diff emits inserts for source ids only in desired`() {
        val desired = listOf(
            ContactsSync.DesiredContact("project:b", "B", "pimote:project:b", "Call B"),
        )
        val existing = emptyList<ContactsSync.ExistingContact>()
        val ops = ContactsSync.diff(desired, existing)
        assertEquals(listOf("project:b"), ops.toInsert.map { it.sourceId })
        assertTrue(ops.toDelete.isEmpty())
        assertTrue(ops.toUpdate.isEmpty())
    }

    @Test
    fun `diff emits deletes for source ids only in existing`() {
        val desired = emptyList<ContactsSync.DesiredContact>()
        val existing = listOf(
            ContactsSync.ExistingContact("project:a", 42L, "A", "pimote:project:a"),
        )
        val ops = ContactsSync.diff(desired, existing)
        assertEquals(listOf(42L), ops.toDelete)
        assertTrue(ops.toInsert.isEmpty())
        assertTrue(ops.toUpdate.isEmpty())
    }

    @Test
    fun `diff emits updates when displayName changes`() {
        val desired = listOf(
            ContactsSync.DesiredContact("project:a", "New", "pimote:project:a", "Call New"),
        )
        val existing = listOf(
            ContactsSync.ExistingContact("project:a", 42L, "Old", "pimote:project:a"),
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
            ContactsSync.DesiredContact("project:a", "A", "pimote:project:a-new", "Call A"),
        )
        val existing = listOf(
            ContactsSync.ExistingContact("project:a", 42L, "A", "pimote:project:a-old"),
        )
        val ops = ContactsSync.diff(desired, existing)
        assertEquals(1, ops.toUpdate.size)
    }

    @Test
    fun `diff is empty when desired equals existing`() {
        val desired = listOf(
            ContactsSync.DesiredContact("project:a", "A", "pimote:project:a", "Call A"),
        )
        val existing = listOf(
            ContactsSync.ExistingContact("project:a", 42L, "A", "pimote:project:a"),
        )
        val ops = ContactsSync.diff(desired, existing)
        assertTrue(ops.toInsert.isEmpty())
        assertTrue(ops.toDelete.isEmpty())
        assertTrue(ops.toUpdate.isEmpty())
    }

    // ------------------------------------------------- classifyExisting

    @Test
    fun `classifyExisting keeps a healthy row under its canonical source id`() {
        val e = ContactsSync.classifyExisting("project:a", 42L, "A", "pimote:project:a")
        assertEquals("project:a", e.sourceId)
        assertEquals(42L, e.rawContactId)
        assertEquals("A", e.displayName)
        assertEquals("pimote:project:a", e.pimoteUri)
    }

    @Test
    fun `classifyExisting marks a full orphan (both rows missing)`() {
        val e = ContactsSync.classifyExisting("project:a", 7L, null, null)
        assertEquals("orphan:7", e.sourceId)
        assertEquals(7L, e.rawContactId)
    }

    @Test
    fun `classifyExisting marks a half-orphan missing the name row`() {
        val e = ContactsSync.classifyExisting("project:a", 7L, null, "pimote:project:a")
        assertEquals("orphan:7", e.sourceId)
    }

    @Test
    fun `classifyExisting marks a half-orphan missing the callable row`() {
        val e = ContactsSync.classifyExisting("project:a", 7L, "A", "")
        assertEquals("orphan:7", e.sourceId)
    }

    @Test
    fun `half-orphan converges via delete plus reinsert, not a no-op update`() {
        // Regression for audit L1: a contact whose callable row was deleted
        // externally must NOT produce an UpdatePair (whose update matches zero
        // rows and re-emits forever). classifyExisting surfaces it as an orphan,
        // so diff deletes the broken raw contact and reinserts the canonical one.
        val desired = listOf(
            ContactsSync.DesiredContact("project:a", "A", "pimote:project:a", "Call A"),
        )
        val existing = listOf(
            ContactsSync.classifyExisting("project:a", 42L, "A", null),
        )
        val ops = ContactsSync.diff(desired, existing)
        assertEquals(listOf(42L), ops.toDelete)
        assertEquals(listOf("project:a"), ops.toInsert.map { it.sourceId })
        assertTrue(ops.toUpdate.isEmpty())
    }
}
