package com.pimote.android.shortcuts

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import com.pimote.android.app.AppContainer
import com.pimote.android.app.MainActivity
import com.pimote.android.session.buildSessionProjectGroups
import com.pimote.android.telephony.PhoneAccountRules
import com.pimote.android.util.L
import kotlin.math.max

/**
 * Headless trampoline activity (`Theme.NoDisplay`). Reads
 * `intent.getStringExtra("participantName")`, resolves it to a pimote URI,
 * and dispatches via [CallByPimoteUri].
 *
 * Resolution order:
 *  1. If value equals [ShortcutsSync.FALLBACK_PARAMETER]: resolve to most-
 *     recently-active project from the SessionRepository snapshot.
 *  2. Else: search known shortcut capability parameters for an exact match.
 *  3. Else: [ShortcutsSync.resolveByFuzzyMatch] over the full project list.
 *  4. Else: launch MainActivity (defensive) and finish.
 */
class CallByNameActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            dispatch()
        } catch (t: Throwable) {
            L.w("Shortcuts", "CallByNameActivity dispatch failed: ${t.message}", t)
        } finally {
            finish()
        }
    }

    private fun dispatch() {
        val participantName = intent?.getStringExtra("participantName")?.trim().orEmpty()
        val container = AppContainer.instance
        val repo = container.sessionRepository
        val projects = repo.projects.value
        val sessions = repo.sessions.value
        val groups = buildSessionProjectGroups(projects, sessions)

        val pimoteUri: String? = when {
            // Empty/missing participantName is treated as the fallback path
            // intentionally: Assistant occasionally fulfills with no parameter,
            // and the fallback's framing ("I just want to talk to my pi") is a
            // better match for that than the defensive MainActivity launch the
            // plan reserves for non-fallback misses. Diverges from plan Step 10's
            // strict `==` test; user-facing result is equivalent in the common case.
            participantName == ShortcutsSync.FALLBACK_PARAMETER || participantName.isEmpty() -> {
                val top = groups.firstOrNull()
                if (top == null) {
                    Toast.makeText(this, "No projects available", Toast.LENGTH_SHORT).show()
                    null
                } else {
                    "pimote:${PhoneAccountRules.projectHandleId(top.project.folderPath)}"
                }
            }
            else -> {
                val cap = max(container.shortcutManagerFacade.getMaxShortcutCountPerActivity(), 2)
                val desired = ShortcutsSync.computeDesiredShortcuts(groups, cap)
                // Exact-match scans both capabilityParameter (the canonical
                // shortLabel) and the synonym set. Synonyms are exactly the
                // utterances Assistant is bound to via addCapabilityBinding,
                // so any of them coming back is a deterministic project match
                // and shouldn't depend on the fuzzy fallback's threshold.
                val match = desired.firstOrNull { s ->
                    if (s.shortcutId == ShortcutsSync.FALLBACK_SHORTCUT_ID) return@firstOrNull false
                    s.capabilityParameter.equals(participantName, ignoreCase = true) ||
                        s.synonyms.any { it.equals(participantName, ignoreCase = true) }
                }
                match?.pimoteUri
                    ?: ShortcutsSync.resolveByFuzzyMatch(participantName, projects)
            }
        }

        if (pimoteUri != null) {
            CallByPimoteUri.placeCall(applicationContext, pimoteUri, container.telecomFacade)
            return
        }

        // Defensive fallback: resolution failed. Surface MainActivity so the
        // user lands somewhere coherent rather than a silent dismiss.
        if (participantName != ShortcutsSync.FALLBACK_PARAMETER && participantName.isNotEmpty()) {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }
}
