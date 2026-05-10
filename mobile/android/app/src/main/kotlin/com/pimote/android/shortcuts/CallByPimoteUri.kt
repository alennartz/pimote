package com.pimote.android.shortcuts

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import com.pimote.android.telephony.PIMOTE_SERVICE_HANDLE_ID
import com.pimote.android.telephony.PIMOTE_URI_SCHEME
import com.pimote.android.telephony.PhoneAccountRules
import com.pimote.android.telephony.PimoteConnectionService
import com.pimote.android.telephony.TelecomFacade
import com.pimote.android.util.L

/**
 * Shared helper used by both trampoline activities to dispatch an outgoing
 * call to a pimote URI via Telecom, scoped to the Pimote self-managed
 * PhoneAccount.
 *
 * Mirrors the inline implementation at `ui/contacts/ContactsScreen.placeCall`
 * so URI construction round-trips through `Uri.fromParts(scheme, ssp, null)`
 * and `PhoneAccountRules.parseDialUri` continues to decode the inbound
 * percent-encoded form on the ConnectionService side.
 */
object CallByPimoteUri {
    /**
     * Place an outgoing call to [pimoteUri] via Telecom. Returns true if
     * dispatched, false if the URI was rejected or dispatch threw.
     *
     * The [telecom] parameter is currently a reserved seam for testing
     * future paths; production calls go through [TelecomManager] directly
     * to match the existing in-app contacts-screen call site.
     */
    @Suppress("UNUSED_PARAMETER")
    fun placeCall(context: Context, pimoteUri: String, telecom: TelecomFacade): Boolean {
        // telecom seam reserved
        if (PhoneAccountRules.parseDialUri(pimoteUri) == null) {
            L.w("Shortcuts", "placeCall rejected unparseable uri=$pimoteUri")
            return false
        }
        val appContext = context.applicationContext
        val tm = appContext.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
            ?: run {
                L.w("Shortcuts", "placeCall: TelecomManager unavailable")
                return false
            }
        val component = ComponentName(appContext, PimoteConnectionService::class.java)
        val handle = PhoneAccountHandle(component, PIMOTE_SERVICE_HANDLE_ID)
        // Strip the "pimote:" scheme to get the SSP, then rebuild via
        // Uri.fromParts so the dispatched URI matches the format
        // ContactsScreen.placeCall produces.
        val ssp = pimoteUri.removePrefix("$PIMOTE_URI_SCHEME:")
        val uri = Uri.fromParts(PIMOTE_URI_SCHEME, ssp, null)
        val extras = Bundle().apply {
            putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
        }
        return try {
            L.i("Shortcuts", "placeCall uri=$uri")
            tm.placeCall(uri, extras)
            true
        } catch (e: SecurityException) {
            L.w("Shortcuts", "placeCall SecurityException: ${e.message}", e)
            false
        } catch (t: Throwable) {
            L.w("Shortcuts", "placeCall failed: ${t.message}", t)
            false
        }
    }
}
