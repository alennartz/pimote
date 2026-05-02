package com.pimote.android.telephony

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Build
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.annotation.RequiresApi

/**
 * Production [TelecomFacade] over [TelecomManager]. The registrar talks
 * exclusively through this facade so unit tests can swap a fake.
 */
class AndroidTelecomFacade(
    private val context: Context,
    private val componentName: ComponentName,
) : TelecomFacade {

    private val tm: TelecomManager =
        context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager

    override fun registeredAccounts(): Map<String, TelecomFacade.Account> {
        val out = mutableMapOf<String, TelecomFacade.Account>()
        for (handle in selfManagedHandles()) {
            val pa = tm.getPhoneAccount(handle) ?: continue
            out[handle.id] = TelecomFacade.Account(
                handleId = handle.id,
                label = pa.label?.toString().orEmpty(),
                shortDescription = pa.shortDescription?.toString().orEmpty(),
            )
        }
        return out
    }

    override fun registerPhoneAccount(account: TelecomFacade.Account) {
        val handle = PhoneAccountHandle(componentName, account.handleId)
        val pa = PhoneAccount.builder(handle, account.label)
            .setShortDescription(account.shortDescription)
            .setAddress(Uri.fromParts("pimote", account.handleId, null))
            .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
            // Declare that this PhoneAccount handles `pimote:` URIs. ContactsContract
            // contacts have a phone-number row of `pimote:session:<id>` /
            // `pimote:project:<base64>`; Telecom routes `placeCall` on those URIs to
            // this PhoneAccount based on the supported scheme.
            .setSupportedUriSchemes(listOf("pimote"))
            .build()
        tm.registerPhoneAccount(pa)
    }

    override fun unregisterPhoneAccount(handleId: String) {
        tm.unregisterPhoneAccount(PhoneAccountHandle(componentName, handleId))
    }

    /**
     * Enumerate self-managed PhoneAccounts registered by THIS app.
     *
     * Prefers `getOwnSelfManagedPhoneAccounts()` (API 31+) which only requires
     * `MANAGE_OWN_CALLS` (already declared) and returns just our app's
     * accounts. The older `getSelfManagedPhoneAccounts()` requires the
     * `READ_PHONE_STATE` runtime permission — we don't want to prompt for
     * that just to clean up our own ghosts.
     *
     * On API 26–30, returns empty (no permission). Cleanup of stale
     * registrations on those versions would require explicit handle ids,
     * which we don't track. Acceptable: the rest of the user base is on
     * API 31+ and the cleanup is a one-time fix for the DR-018 → DR-019
     * transition.
     */
    private fun selfManagedHandles(): List<PhoneAccountHandle> = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> ownSelfManagedApi31()
        else -> emptyList()
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun ownSelfManagedApi31(): List<PhoneAccountHandle> =
        runCatching { tm.ownSelfManagedPhoneAccounts.toList() }.getOrDefault(emptyList())
}
