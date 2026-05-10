package com.pimote.android.shortcuts

import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.session.SessionProjectGroup
import com.pimote.android.telephony.PhoneAccountRules
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Pure unit tests for [ShortcutsSync] \u2014 desired-set derivation, diff,
 * synonyms, and fuzzy-match resolver. Mirrors `ContactsSyncTest` in scope:
 * everything tested here is plain Kotlin (no Android types).
 */
class ShortcutsSyncTest {

    private fun group(path: String, name: String, lastModified: String = ""): SessionProjectGroup =
        SessionProjectGroup(
            project = ProjectMeta(folderPath = path, folderName = name),
            sessions = emptyList<SessionMeta>(),
            lastModified = lastModified,
        )

    // ----------------------------------------------- computeDesiredShortcuts

    @Test
    fun `result always contains the fallback shortcut at rank 0`() {
        val out = ShortcutsSync.computeDesiredShortcuts(emptyList(), maxShortcuts = 5)
        assertEquals(1, out.size)
        val fallback = out.first()
        assertEquals(ShortcutsSync.FALLBACK_SHORTCUT_ID, fallback.shortcutId)
        assertEquals(0, fallback.rank)
        assertEquals(ShortcutsSync.FALLBACK_PARAMETER, fallback.capabilityParameter)
        assertNull(fallback.pimoteUri)
    }

    @Test
    fun `result is capped at maxShortcuts entries`() {
        val groups = (1..20).map { group("/work/repo$it", "repo$it", "2026-04-0${it.coerceAtMost(9)}T00:00:00Z") }
        val out = ShortcutsSync.computeDesiredShortcuts(groups, maxShortcuts = 5)
        assertEquals(5, out.size)
    }

    @Test
    fun `top maxShortcuts minus one projects are picked from the head of the input ordering`() {
        // Caller passes already-sorted groups (most-recent first). The function
        // should preserve that ordering when picking the top N-1.
        val groups = listOf(
            group("/work/alpha", "alpha", "2026-04-09T00:00:00Z"),
            group("/work/beta", "beta", "2026-04-08T00:00:00Z"),
            group("/work/gamma", "gamma", "2026-04-07T00:00:00Z"),
            group("/work/delta", "delta", "2026-04-06T00:00:00Z"),
        )
        val out = ShortcutsSync.computeDesiredShortcuts(groups, maxShortcuts = 3)
        // 1 fallback + 2 projects
        assertEquals(3, out.size)
        val projectIds = out.drop(1).map { it.shortcutId }
        assertEquals(
            listOf(
                PhoneAccountRules.projectHandleId("/work/alpha"),
                PhoneAccountRules.projectHandleId("/work/beta"),
            ),
            projectIds,
        )
    }

    @Test
    fun `project shortLabel uses root and project name`() {
        val groups = listOf(group("/repos/pimote", "pimote", "2026-04-09T00:00:00Z"))
        val out = ShortcutsSync.computeDesiredShortcuts(groups, maxShortcuts = 5)
        val project = out.first { it.shortcutId != ShortcutsSync.FALLBACK_SHORTCUT_ID }
        assertEquals("repos pimote", project.shortLabel)
    }

    @Test
    fun `project longLabel begins with Call`() {
        val groups = listOf(group("/repos/pimote", "pimote", "2026-04-09T00:00:00Z"))
        val out = ShortcutsSync.computeDesiredShortcuts(groups, maxShortcuts = 5)
        val project = out.first { it.shortcutId != ShortcutsSync.FALLBACK_SHORTCUT_ID }
        assertTrue(project.longLabel.startsWith("Call "))
    }

    @Test
    fun `project shortcuts carry a pimote project URI`() {
        val groups = listOf(group("/work/repo", "repo", "2026-04-09T00:00:00Z"))
        val out = ShortcutsSync.computeDesiredShortcuts(groups, maxShortcuts = 5)
        val project = out.first { it.shortcutId != ShortcutsSync.FALLBACK_SHORTCUT_ID }
        assertNotNull(project.pimoteUri)
        assertEquals("pimote:${PhoneAccountRules.projectHandleId("/work/repo")}", project.pimoteUri)
    }

    @Test
    fun `project rank is non-zero and ascending by recency`() {
        val groups = listOf(
            group("/work/alpha", "alpha", "2026-04-09T00:00:00Z"),
            group("/work/beta", "beta", "2026-04-08T00:00:00Z"),
        )
        val out = ShortcutsSync.computeDesiredShortcuts(groups, maxShortcuts = 5)
        val ranks = out.map { it.rank }
        assertEquals(listOf(0, 1, 2), ranks)
    }

    @Test
    fun `fallback shortcut carries the FALLBACK_SYNONYMS list`() {
        val out = ShortcutsSync.computeDesiredShortcuts(emptyList(), maxShortcuts = 5)
        assertEquals(ShortcutsSync.FALLBACK_SYNONYMS, out.single().synonyms)
    }

    @Test
    fun `maxShortcuts of 1 returns only the fallback`() {
        // Edge: cap leaves no room for any project.
        val groups = listOf(group("/work/repo", "repo", "2026-04-09T00:00:00Z"))
        val out = ShortcutsSync.computeDesiredShortcuts(groups, maxShortcuts = 1)
        assertEquals(1, out.size)
        assertEquals(ShortcutsSync.FALLBACK_SHORTCUT_ID, out.single().shortcutId)
    }

    // ------------------------------------------------------------- synonymsFor

    @Test
    fun `synonymsFor includes the bare project name`() {
        val syn = ShortcutsSync.synonymsFor("repos", "pimote")
        assertTrue(syn.contains("pimote"))
    }

    @Test
    fun `synonymsFor includes a root-and-project combination`() {
        val syn = ShortcutsSync.synonymsFor("repos", "pimote")
        assertTrue(syn.contains("repos pimote"))
    }

    @Test
    fun `synonymsFor with null root returns just the project name`() {
        val syn = ShortcutsSync.synonymsFor(null, "pimote")
        assertEquals(listOf("pimote"), syn)
    }

    @Test
    fun `synonymsFor never includes pronunciation variants of Pimote`() {
        // Pronunciation variants belong only on the fallback shortcut.
        val syn = ShortcutsSync.synonymsFor("repos", "pimote")
        assertFalse(syn.any { it.contains("pee", ignoreCase = true) })
        assertFalse(syn.any { it.contains("pie", ignoreCase = true) })
    }

    // ------------------------------------------------------- resolveByFuzzyMatch

    @Test
    fun `resolveByFuzzyMatch returns null on empty project list`() {
        assertNull(ShortcutsSync.resolveByFuzzyMatch("anything", emptyList()))
    }

    @Test
    fun `resolveByFuzzyMatch returns a pimote URI when an exact name matches`() {
        val projects = listOf(
            ProjectMeta("/repos/pimote", "pimote"),
            ProjectMeta("/work/other", "other"),
        )
        val uri = ShortcutsSync.resolveByFuzzyMatch("pimote", projects)
        assertEquals("pimote:${PhoneAccountRules.projectHandleId("/repos/pimote")}", uri)
    }

    @Test
    fun `resolveByFuzzyMatch returns null for utterances that match nothing recognisable`() {
        val projects = listOf(ProjectMeta("/repos/pimote", "pimote"))
        assertNull(ShortcutsSync.resolveByFuzzyMatch("zzzqqqxxx", projects))
    }

    // -------------------------------------------------------------------- diff

    private fun shortcut(
        id: String,
        label: String = "L",
        param: String = "p",
        synonyms: List<String> = listOf("p"),
        uri: String? = "pimote:$id",
        rank: Int = 1,
    ) = DesiredShortcut(
        shortcutId = id,
        shortLabel = label,
        longLabel = "Call $label",
        capabilityParameter = param,
        synonyms = synonyms,
        pimoteUri = uri,
        rank = rank,
    )

    @Test
    fun `diff emits upserts for ids only in desired`() {
        val ops = ShortcutsSync.diff(
            desired = listOf(shortcut("project:a")),
            existing = emptyList(),
        )
        assertEquals(listOf("project:a"), ops.toUpsert.map { it.shortcutId })
        assertTrue(ops.toDelete.isEmpty())
    }

    @Test
    fun `diff emits deletes for ids only in existing`() {
        val ops = ShortcutsSync.diff(
            desired = emptyList(),
            existing = listOf(shortcut("project:a")),
        )
        assertEquals(listOf("project:a"), ops.toDelete)
        assertTrue(ops.toUpsert.isEmpty())
    }

    @Test
    fun `diff emits upserts when content differs even if ids match`() {
        val ops = ShortcutsSync.diff(
            desired = listOf(shortcut("project:a", label = "New")),
            existing = listOf(shortcut("project:a", label = "Old")),
        )
        assertEquals(listOf("project:a"), ops.toUpsert.map { it.shortcutId })
        assertTrue(ops.toDelete.isEmpty())
    }

    @Test
    fun `diff treats rank, synonyms, pimoteUri, and capabilityParameter as content`() {
        // Architecture: diff by shortcutId + content equality. Any field that
        // is part of DesiredShortcut affects what gets pushed to the system,
        // so a change to any of them must trigger an upsert.
        val base = shortcut("project:a")
        val mutations = listOf(
            base.copy(rank = base.rank + 1),
            base.copy(synonyms = base.synonyms + "extra"),
            base.copy(pimoteUri = "pimote:project:different"),
            base.copy(capabilityParameter = "different-param"),
        )
        for (mutated in mutations) {
            val ops = ShortcutsSync.diff(
                desired = listOf(mutated),
                existing = listOf(base),
            )
            assertEquals(
                listOf("project:a"),
                ops.toUpsert.map { it.shortcutId },
                "expected upsert when mutating to $mutated",
            )
            assertTrue(ops.toDelete.isEmpty(), "unexpected delete for $mutated")
        }
    }

    @Test
    fun `diff is empty when desired equals existing`() {
        val s = shortcut("project:a")
        val ops = ShortcutsSync.diff(desired = listOf(s), existing = listOf(s))
        assertTrue(ops.toUpsert.isEmpty())
        assertTrue(ops.toDelete.isEmpty())
    }
}
