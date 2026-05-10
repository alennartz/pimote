package com.pimote.android.shortcuts

import android.app.Activity
import android.os.Bundle

/**
 * Headless trampoline (`Theme.NoDisplay`) for the contact-card `ACTION_VIEW`
 * path. Reads `intent.data` (the Data row URI), queries
 * `ContactsContract.Data` for `data1`, and dispatches via [CallByPimoteUri].
 */
class CallByDataRowActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Implementation deferred. Always finish() immediately.
        finish()
    }
}
