package com.pimote.android.shortcuts

import android.app.Activity
import android.os.Bundle

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
        // Implementation deferred. Always finish() immediately.
        finish()
    }
}
