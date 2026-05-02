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
 * Outgoing-call dispatch:
 *   - The dialed URI on `request.address` carries the target session/project,
 *     e.g. `pimote:session:abc123` or `pimote:project:<base64>`.
 *   - We parse the URI via [PhoneAccountRules.parseDialUri] and construct a
 *     [SessionTarget] from it, then start the call via [com.pimote.android.call.CallController].
 *   - There is exactly one PhoneAccount registered (the Pimote service); per-
 *     session/project PhoneAccounts were removed in DR-019 because Telecom
 *     caps PhoneAccount registrations at 10 per app.
 *
 * Dependencies are resolved from `AppContainer` lazily on first method call —
 * the framework instantiates the service via reflection so we cannot inject
 * through the constructor.
 */
class PimoteConnectionService : ConnectionService() {

    override fun onCreateOutgoingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?,
    ): Connection {
        val container = AppContainer.instance
        val uri = request?.address?.toString()
        val parsed = uri?.let { PhoneAccountRules.parseDialUri(it) }

        if (parsed == null) {
            val c = object : Connection() {}
            c.setDisconnected(DisconnectCause(DisconnectCause.ERROR, "unrecognized dial URI: $uri"))
            c.destroy()
            return c
        }

        val target: SessionTarget = when (parsed) {
            is PhoneAccountRules.ParsedDial.Session -> SessionTarget.ExistingSession(parsed.sessionId)
            is PhoneAccountRules.ParsedDial.Project -> SessionTarget.NewSessionInProject(parsed.folderPath)
        }

        val conn = PimoteConnection(container.callController, target)
        conn.setInitializing()
        conn.setAudioModeIsVoip(true)
        conn.connectionCapabilities = Connection.CAPABILITY_MUTE or Connection.CAPABILITY_SUPPORT_HOLD
        request.address?.let { conn.setAddress(it, TelecomManager.PRESENTATION_ALLOWED) }
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
