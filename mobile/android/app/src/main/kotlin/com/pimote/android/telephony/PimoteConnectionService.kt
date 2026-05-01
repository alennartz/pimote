package com.pimote.android.telephony

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import com.pimote.android.app.AppContainer
import com.pimote.android.call.SessionTarget

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
        val container = AppContainer.instance
        val handleId = request?.accountHandle?.id
        val kind = handleId?.let { container.phoneAccountRegistrar.resolve(it) }
        if (kind == null) {
            val c = object : Connection() {}
            c.setDisconnected(DisconnectCause(DisconnectCause.ERROR, "unknown account"))
            c.destroy()
            return c
        }
        val target: SessionTarget = when (kind) {
            is AccountKind.Session -> SessionTarget.ExistingSession(kind.sessionId)
            is AccountKind.Project -> SessionTarget.NewSessionInProject(kind.folderPath)
        }
        val conn = PimoteConnection(container.callController, target)
        conn.setInitializing()
        conn.setAudioModeIsVoip(true)
        conn.connectionCapabilities = Connection.CAPABILITY_MUTE or Connection.CAPABILITY_SUPPORT_HOLD
        request?.address?.let { conn.setAddress(it, TelecomManager.PRESENTATION_ALLOWED) }
        container.callController.startOutgoing(target, conn)
        return conn
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
