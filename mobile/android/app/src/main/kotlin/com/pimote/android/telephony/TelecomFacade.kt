package com.pimote.android.telephony

/**
 * Test seam over [android.telecom.TelecomManager] + [android.telecom.PhoneAccount].
 *
 * The real Telecom framework is not available under JVM unit tests, so the
 * registrar talks through this facade instead of [android.telecom.TelecomManager]
 * directly. Production binds a thin adapter that forwards to the system
 * services; tests bind a fake.
 *
 * The facade speaks in terms of plain handles + display labels — it does not
 * leak `PhoneAccount`/`PhoneAccountHandle` types so unit tests remain pure
 * Kotlin.
 */
interface TelecomFacade {
    /**
     * A registered Telecom phone account, as the registrar reasons about it.
     * [handleId] is the value placed into `PhoneAccountHandle.id`. [label] is
     * the sanitized display name. [shortDescription] is the secondary line.
     */
    data class Account(
        val handleId: String,
        val label: String,
        val shortDescription: String,
    )

    /** Currently-registered accounts owned by this app, keyed by [Account.handleId]. */
    fun registeredAccounts(): Map<String, Account>

    /** Register or replace [account] in Telecom. */
    fun registerPhoneAccount(account: Account)

    /** Unregister the account with the given [handleId]. No-op if absent. */
    fun unregisterPhoneAccount(handleId: String)
}
