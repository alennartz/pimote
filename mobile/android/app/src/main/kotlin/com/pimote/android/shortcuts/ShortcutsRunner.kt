package com.pimote.android.shortcuts

import android.content.Context
import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.session.SessionRepository
import com.pimote.android.session.buildSessionProjectGroups
import com.pimote.android.util.L
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch
import kotlin.math.max

/**
 * Observes [SessionRepository] and reconciles the desired dynamic-shortcut
 * set with [ShortcutManagerFacade], debounced.
 *
 * Reconcile loop:
 *   1. groups = buildSessionProjectGroups(projects, sessions)
 *   2. cap = max(shortcutManager.getMaxShortcutCountPerActivity(), 2)
 *   3. desired = ShortcutsSync.computeDesiredShortcuts(groups, cap)
 *   4. existing = shortcutManager.getDynamicShortcuts()
 *   5. if desired != existing: shortcutManager.setDynamicShortcuts(desired)
 */
class ShortcutsRunner(
    private val context: Context,
    private val repository: SessionRepository,
    private val shortcutManager: ShortcutManagerFacade,
    private val scope: CoroutineScope,
    private val debounceMs: Long = 2_000L,
) {
    private var job: Job? = null

    @FlowPreview
    @ExperimentalCoroutinesApi
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            combine(repository.projects, repository.sessions) { p, s -> p to s }
                .debounce(debounceMs)
                .collect { (projects, sessions) ->
                    runCatching { reconcile(projects, sessions) }
                        .onFailure { L.w("Shortcuts", "reconcile failed: ${it.message}", it) }
                }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    private fun reconcile(projects: List<ProjectMeta>, sessions: List<SessionMeta>) {
        val groups = buildSessionProjectGroups(projects, sessions)
        val cap = max(shortcutManager.getMaxShortcutCountPerActivity(), 2)
        val desired = ShortcutsSync.computeDesiredShortcuts(groups, cap)
        val existing = shortcutManager.getDynamicShortcuts()
        if (desired != existing) {
            shortcutManager.setDynamicShortcuts(desired)
        }
    }
}
