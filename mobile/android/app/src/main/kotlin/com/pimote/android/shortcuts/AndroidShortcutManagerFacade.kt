package com.pimote.android.shortcuts

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat

/**
 * Production binding over `ShortcutManagerCompat`. Translates
 * [DesiredShortcut] instances to `ShortcutInfoCompat` (with
 * `addCapabilityBinding(...)`, `setRank(...)`, `setLongLived(true)`,
 * `setIntent(...)` pointing at `CallByNameActivity` with `participantName`
 * extra equal to [DesiredShortcut.capabilityParameter]).
 *
 * The four [DesiredShortcut] fields not natively exposed by
 * `ShortcutInfoCompat` getters (`capabilityParameter`, `synonyms`,
 * `pimoteUri`, plus the capability binding itself) are round-tripped via a
 * `PersistableBundle` set with `setExtras` so [getDynamicShortcuts] can
 * reconstruct the original [DesiredShortcut] for diffing.
 */
class AndroidShortcutManagerFacade(
    private val context: Context,
) : ShortcutManagerFacade {

    private companion object {
        const val FALLBACK_MAX = 15
        const val EXTRA_CAPABILITY_PARAMETER = "capabilityParameter"
        const val EXTRA_SYNONYMS = "synonyms"
        const val EXTRA_PIMOTE_URI = "pimoteUri"
        const val CAPABILITY_NAME = "actions.intent.CREATE_CALL"
        const val CAPABILITY_PARAM_NAME = "call.participant.name"
    }

    override fun getMaxShortcutCountPerActivity(): Int {
        val v = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context)
        return if (v < 2) FALLBACK_MAX else v
    }

    override fun setDynamicShortcuts(shortcuts: List<DesiredShortcut>) {
        val componentName = ComponentName(context, CallByNameActivity::class.java)
        val infos = shortcuts.map { s ->
            val intent = Intent(Intent.ACTION_VIEW).apply {
                component = componentName
                putExtra("participantName", s.capabilityParameter)
            }
            val extras = PersistableBundle().apply {
                putString(EXTRA_CAPABILITY_PARAMETER, s.capabilityParameter)
                putStringArray(EXTRA_SYNONYMS, s.synonyms.toTypedArray())
                if (s.pimoteUri != null) putString(EXTRA_PIMOTE_URI, s.pimoteUri)
            }
            ShortcutInfoCompat.Builder(context, s.shortcutId)
                .setShortLabel(s.shortLabel)
                .setLongLabel(s.longLabel)
                .setRank(s.rank)
                .setLongLived(true)
                .setIntent(intent)
                .setExtras(extras)
                .addCapabilityBinding(
                    CAPABILITY_NAME,
                    CAPABILITY_PARAM_NAME,
                    s.synonyms,
                )
                .build()
        }
        ShortcutManagerCompat.setDynamicShortcuts(context, infos)
    }

    override fun getDynamicShortcuts(): List<DesiredShortcut> {
        val infos = ShortcutManagerCompat.getDynamicShortcuts(context)
        return infos.map { info ->
            val extras = info.extras
            val capabilityParameter = extras?.getString(EXTRA_CAPABILITY_PARAMETER) ?: ""
            val synonyms = extras?.getStringArray(EXTRA_SYNONYMS)?.toList() ?: emptyList()
            val pimoteUri = extras?.getString(EXTRA_PIMOTE_URI)
            DesiredShortcut(
                shortcutId = info.id,
                shortLabel = info.shortLabel.toString(),
                longLabel = info.longLabel?.toString() ?: "",
                capabilityParameter = capabilityParameter,
                synonyms = synonyms,
                pimoteUri = pimoteUri,
                rank = info.rank,
            )
        }
    }
}
