package com.pimote.android.shortcuts

import android.content.Context

/**
 * Production binding over `ShortcutManagerCompat`. Translates
 * [DesiredShortcut] instances to `ShortcutInfoCompat` (with
 * `addCapabilityBinding(...)`, `setRank(...)`, `setLongLived(true)`,
 * `setIntent(...)` pointing at `CallByNameActivity` with `participantName`
 * extra equal to [DesiredShortcut.capabilityParameter]).
 */
class AndroidShortcutManagerFacade(
    private val context: Context,
) : ShortcutManagerFacade {

    override fun getMaxShortcutCountPerActivity(): Int {
        TODO("not implemented")
    }

    override fun setDynamicShortcuts(shortcuts: List<DesiredShortcut>) {
        TODO("not implemented")
    }

    override fun getDynamicShortcuts(): List<DesiredShortcut> {
        TODO("not implemented")
    }
}
