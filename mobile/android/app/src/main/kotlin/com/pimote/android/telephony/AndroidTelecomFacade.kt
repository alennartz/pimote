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
            .build()
        tm.registerPhoneAccount(pa)
    }

    override fun unregisterPhoneAccount(handleId: String) {
        tm.unregisterPhoneAccount(PhoneAccountHandle(componentName, handleId))
    }

    @Suppress("DEPRECATION")
    private fun selfManagedHandles(): List<PhoneAccountHandle> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        selfManagedApi26()
    } else {
        emptyList()
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun selfManagedApi26(): List<PhoneAccountHandle> =
        runCatching { tm.selfManagedPhoneAccounts.toList() }.getOrDefault(emptyList())
}
