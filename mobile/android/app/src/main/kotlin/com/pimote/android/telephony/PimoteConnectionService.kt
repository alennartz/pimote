package com.pimote.android.telephony

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle

/**
 * Android Telecom entry point. Outgoing-only in v1: incoming requests return
 * a failed connection.
 *
 * Dependencies are resolved from `AppContainer` lazily on first method call —
 * the framework instantiates the service via reflection so we cannot inject
 * through the constructor. See docs/plans/native-android-client.md
 * §PimoteConnectionService for the contract.
 */
class PimoteConnectionService : ConnectionService() {

    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?,
    ): Connection {
        TODO("not implemented")
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?,
    ): Connection {
        // Outgoing-only in v1.
        val c = object : Connection() {}
        c.setDisconnected(DisconnectCause(DisconnectCause.REJECTED, "incoming not supported"))
        c.destroy()
        return c
    }
}
