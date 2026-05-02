package com.pimote.android.accounts

import android.accounts.AbstractAccountAuthenticator
import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.content.Context
import android.os.Bundle

/**
 * Stub [AbstractAccountAuthenticator]. Pimote doesn't authenticate users —
 * auth is handled at the network layer (per DR-017). This authenticator
 * exists solely so the system has an `Account` for our app, which is what
 * the contacts sync layer hangs `ContactsContract.RawContacts` off of.
 *
 * The Account itself shows up in **Settings → Accounts → Pimote**. From
 * there a user can disable / remove the account, which removes our synced
 * contacts. That's the cleanup-on-uninstall mechanism the platform uses for
 * apps that own contacts.
 *
 * All authenticator methods return null/no-op because we never prompt for
 * credentials.
 */
class PimoteAccountAuthenticator(context: Context) : AbstractAccountAuthenticator(context) {
    override fun editProperties(response: AccountAuthenticatorResponse?, accountType: String?): Bundle? = null
    override fun addAccount(
        response: AccountAuthenticatorResponse?,
        accountType: String?,
        authTokenType: String?,
        requiredFeatures: Array<out String>?,
        options: Bundle?,
    ): Bundle? = null

    override fun confirmCredentials(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        options: Bundle?,
    ): Bundle? = null

    override fun getAuthToken(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        authTokenType: String?,
        options: Bundle?,
    ): Bundle? = null

    override fun getAuthTokenLabel(authTokenType: String?): String? = null

    override fun updateCredentials(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        authTokenType: String?,
        options: Bundle?,
    ): Bundle? = null

    override fun hasFeatures(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        features: Array<out String>?,
    ): Bundle = Bundle().apply { putBoolean(android.accounts.AccountManager.KEY_BOOLEAN_RESULT, false) }
}
