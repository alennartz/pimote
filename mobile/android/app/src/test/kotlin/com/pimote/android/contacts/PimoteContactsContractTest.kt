package com.pimote.android.contacts

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for [PimoteContactsContract]. Pins the custom MIME
 * string and the column-by-column shape of the callable data row that
 * `ContactSyncRunner` writes to `ContactsContract.Data` and that
 * `res/xml/contacts.xml` references.
 *
 * The MIME string and the column semantics are part of an external
 * platform contract: changing them in code without changing the XML
 * (or vice versa) silently breaks Assistant / contact-card discovery.
 * These tests pin both sides to the same constants.
 */
class PimoteContactsContractTest {

    // ----------------------------------------------------- constants

    @Test
    fun `MIME_CALLABLE is the package-namespaced cursor item type`() {
        assertEquals(
            "vnd.android.cursor.item/vnd.com.pimote.android.call",
            PimoteContactsContract.MIME_CALLABLE,
        )
    }

    @Test
    fun `LABEL is the short user-visible row label`() {
        assertEquals("Pimote", PimoteContactsContract.LABEL)
    }

    // ----------------------------------------------------- callableRowFor

    private fun desired(
        sourceId: String = "session:abc",
        displayName: String = "repo/feat",
        pimoteUri: String = "pimote:session:abc",
        summary: String = "Call repo/feat",
    ) = ContactsSync.DesiredContact(sourceId, displayName, pimoteUri, summary)

    @Test
    fun `callableRowFor uses the custom MIME type`() {
        val row = PimoteContactsContract.callableRowFor(desired())
        assertEquals(PimoteContactsContract.MIME_CALLABLE, row.mimeType)
    }

    @Test
    fun `callableRowFor maps DATA1 to the pimote dial URI`() {
        val row = PimoteContactsContract.callableRowFor(desired(pimoteUri = "pimote:session:xyz"))
        assertEquals("pimote:session:xyz", row.data1)
    }

    @Test
    fun `callableRowFor maps DATA2 to the short Pimote label`() {
        val row = PimoteContactsContract.callableRowFor(desired())
        assertEquals(PimoteContactsContract.LABEL, row.data2)
    }

    @Test
    fun `callableRowFor maps DATA3 to the desired contact summary`() {
        val row = PimoteContactsContract.callableRowFor(desired(summary = "Call work/repo/feat"))
        assertEquals("Call work/repo/feat", row.data3)
    }

    @Test
    fun `callableRowFor marks the row as primary`() {
        val row = PimoteContactsContract.callableRowFor(desired())
        assertEquals(1, row.isPrimary)
    }

    @Test
    fun `callableRowFor preserves project URIs verbatim`() {
        val row = PimoteContactsContract.callableRowFor(
            desired(
                sourceId = "project:Lw",  // base64url("/")
                pimoteUri = "pimote:project:Lw",
                summary = "New session in repo",
            ),
        )
        assertEquals("pimote:project:Lw", row.data1)
        assertEquals("New session in repo", row.data3)
    }
}
