package com.pimote.android.telephony

import android.telecom.CallAudioState
import android.telecom.Connection
import com.pimote.android.call.CallController
import com.pimote.android.call.CallEndReason
import com.pimote.android.call.SessionTarget

/**
 * The single live [android.telecom.Connection] for an outgoing pimote call.
 * Bridges Telecom callbacks into [CallController] and exposes a [CallConnection]
 * surface back the other way.
 *
 * Construction is owned by [PimoteConnectionService.onCreateOutgoingConnection].
 */
class PimoteConnection(
    private val callController: CallController,
    private val target: SessionTarget,
) : Connection(), CallConnection {

    // Telecom → app callbacks
    override fun onDisconnect() {
        TODO("not implemented")
    }

    override fun onCallAudioStateChanged(state: CallAudioState?) {
        TODO("not implemented")
    }

    override fun onAbort() {
        TODO("not implemented")
    }

    override fun onReject() {
        // Outgoing-only in v1; any reject is treated as a hangup.
        onDisconnect()
    }

    override fun onAnswer() {
        // n/a — outgoing-only.
    }

    // App → Telecom transitions (CallConnection)
    override fun markRinging() {
        TODO("not implemented")
    }

    override fun markActive() {
        TODO("not implemented")
    }

    override fun markFailed(reason: String) {
        TODO("not implemented")
    }

    override fun markEndedRemotely(reason: CallEndReason) {
        TODO("not implemented")
    }
}
