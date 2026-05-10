package com.pimote.android.shortcuts

import android.content.Context
import com.pimote.android.session.SessionRepository
import kotlinx.coroutines.CoroutineScope

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
    fun start() {
        TODO("not implemented")
    }

    fun stop() {
        TODO("not implemented")
    }
}
