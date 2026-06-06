package com.pimote.android.shortcuts

import android.app.Activity
import android.os.Bundle
import android.provider.ContactsContract
import com.pimote.android.app.pimoteContainer
import com.pimote.android.telephony.PhoneAccountRules
import com.pimote.android.util.L

/**
 * Headless trampoline (`Theme.NoDisplay`) for the contact-card `ACTION_VIEW`
 * path. Reads `intent.data` (the Data row URI), queries
 * `ContactsContract.Data` for `data1`, and dispatches via [CallByPimoteUri].
 */
class CallByDataRowActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            dispatch()
        } catch (t: Throwable) {
            L.w("Shortcuts", "CallByDataRowActivity dispatch failed: ${t.message}", t)
        } finally {
            finish()
        }
    }

    private fun dispatch() {
        val rowUri = intent?.data ?: return
        val data1: String? = contentResolver.query(
            rowUri,
            arrayOf(ContactsContract.Data.DATA1),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
        if (data1.isNullOrBlank()) return
        if (PhoneAccountRules.parseDialUri(data1) == null) {
            L.w("Shortcuts", "CallByDataRowActivity rejected uri=$data1")
            return
        }
        CallByPimoteUri.placeCall(
            applicationContext,
            data1,
            pimoteContainer.telecomFacade,
        )
    }
}
