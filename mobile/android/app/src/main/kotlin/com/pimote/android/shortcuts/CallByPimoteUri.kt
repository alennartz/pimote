package com.pimote.android.shortcuts

import android.content.Context
import com.pimote.android.telephony.TelecomFacade

/**
 * Shared helper used by both trampoline activities to dispatch an outgoing
 * call to a pimote URI via Telecom, scoped to the Pimote self-managed
 * PhoneAccount.
 */
object CallByPimoteUri {
    /**
     * Place an outgoing call to [pimoteUri] via Telecom. Returns true if
     * dispatched, false if the URI was rejected or the PhoneAccount is
     * missing.
     */
    fun placeCall(context: Context, pimoteUri: String, telecom: TelecomFacade): Boolean {
        TODO("not implemented")
    }
}
