package com.pimote.android.shortcuts

/**
 * Test seam over [androidx.core.content.pm.ShortcutManagerCompat]. The runner
 * talks through this so unit tests can swap a fake.
 */
interface ShortcutManagerFacade {
    /** Runtime cap. Returns 15 (or another safe constant) if the system value is unavailable. */
    fun getMaxShortcutCountPerActivity(): Int

    /** Replace the full set of dynamic shortcuts. Idempotent on equal inputs. */
    fun setDynamicShortcuts(shortcuts: List<DesiredShortcut>)

    /** Read current dynamic shortcuts (for diff). */
    fun getDynamicShortcuts(): List<DesiredShortcut>
}
