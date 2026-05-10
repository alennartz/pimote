package com.pimote.android.shortcuts

import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionProjectGroup

/**
 * Pure-function derivation of the desired App Actions / dynamic-shortcut set.
 *
 * Mirrors the shape of [com.pimote.android.contacts.ContactsSync] for the
 * shortcuts surface. Implementation lives in the test-write phase as a stub;
 * later filled in to satisfy the behavioral tests.
 */
data class DesiredShortcut(
    /** "project:<base64>" or [ShortcutsSync.FALLBACK_SHORTCUT_ID]. */
    val shortcutId: String,
    /** e.g. "repos pimote", or a user-visible label for the fallback. */
    val shortLabel: String,
    /** e.g. "Call repos pimote". */
    val longLabel: String,
    /** Value bound to `call.participant.name`; [ShortcutsSync.FALLBACK_PARAMETER] for the fallback. */
    val capabilityParameter: String,
    /** Utterance variants for the parameter binding. */
    val synonyms: List<String>,
    /** `pimote:project:<base64>` for project shortcuts; null for fallback (resolved at fulfillment time). */
    val pimoteUri: String?,
    /** 0 = highest. Drives `ShortcutInfoCompat.setRank()`. */
    val rank: Int,
)

object ShortcutsSync {

    /** Fixed sentinel id for the generic fallback shortcut. */
    const val FALLBACK_SHORTCUT_ID: String = "fallback"

    /** Fixed sentinel parameter value for the generic fallback shortcut. */
    const val FALLBACK_PARAMETER: String = "fallback"

    /**
     * Synonyms for the generic fallback shortcut, including pronunciation
     * variants. Order is significant only for stability of the assertion.
     */
    val FALLBACK_SYNONYMS: List<String> = listOf(
        "Pimote",
        "pee mote",
        "pee-mote",
        "pie mote",
        "pie-mote",
        "my pi",
    )

    data class SyncOps(
        val toDelete: List<String>,
        val toUpsert: List<DesiredShortcut>,
    )

    /**
     * Build the desired shortcut list from sorted project groups (most-recent
     * first) and the runtime cap. Returns at most [maxShortcuts] entries:
     *  - rank 0: the generic fallback shortcut (always present)
     *  - rank 1..N-1: top (maxShortcuts - 1) projects by recency
     */
    fun computeDesiredShortcuts(
        groups: List<SessionProjectGroup>,
        maxShortcuts: Int,
    ): List<DesiredShortcut> {
        TODO("not implemented")
    }

    /** Diff two lists by [DesiredShortcut.shortcutId] + content equality. */
    fun diff(
        desired: List<DesiredShortcut>,
        existing: List<DesiredShortcut>,
    ): SyncOps {
        TODO("not implemented")
    }

    /**
     * Synonym set for a project shortcut. No pronunciation variants here \u2014
     * those only go on the fallback shortcut.
     */
    fun synonymsFor(rootSegment: String?, projectName: String): List<String> {
        TODO("not implemented")
    }

    /**
     * Best-effort match of an Assistant-recognized utterance against the full
     * project list. Returns the matched project's pimoteUri or null if no
     * candidate scores above an internal threshold.
     */
    fun resolveByFuzzyMatch(
        utterance: String,
        projects: List<ProjectMeta>,
    ): String? {
        TODO("not implemented")
    }
}
