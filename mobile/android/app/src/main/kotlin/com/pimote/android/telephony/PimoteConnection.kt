package com.pimote.android.telephony

import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.DisconnectCause
import com.pimote.android.call.AudioRoute
import com.pimote.android.call.AudioRouteSnapshot
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
        callController.endCurrentCall()
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
    }

    override fun onCallAudioStateChanged(state: CallAudioState?) {
        if (state != null) {
            callController.onAudioStateChanged(toSnapshot(state))
        }
    }

    override fun onAbort() {
        onDisconnect()
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
        setRinging()
    }

    override fun markActive() {
        setActive()
    }

    override fun markFailed(reason: String) {
        setDisconnected(DisconnectCause(DisconnectCause.ERROR, reason))
        destroy()
    }

    override fun markEndedRemotely(reason: CallEndReason) {
        setDisconnected(DisconnectCause(mapEndReasonToDisconnectCause(reason)))
        destroy()
    }

    private fun mapEndReasonToDisconnectCause(reason: CallEndReason): Int = when (reason) {
        CallEndReason.USER_HANGUP, CallEndReason.REMOTE_HANGUP -> DisconnectCause.REMOTE
        CallEndReason.DISPLACED -> DisconnectCause.CANCELED
        CallEndReason.SERVER_ENDED -> DisconnectCause.REMOTE
        CallEndReason.PEER_FAILED, CallEndReason.BIND_FAILED -> DisconnectCause.ERROR
    }

    private fun toSnapshot(state: CallAudioState): AudioRouteSnapshot {
        val route = when (state.route) {
            CallAudioState.ROUTE_EARPIECE -> AudioRoute.EARPIECE
            CallAudioState.ROUTE_SPEAKER -> AudioRoute.SPEAKER
            CallAudioState.ROUTE_BLUETOOTH -> AudioRoute.BLUETOOTH
            CallAudioState.ROUTE_WIRED_HEADSET -> AudioRoute.WIRED_HEADSET
            else -> AudioRoute.EARPIECE
        }
        val supported = mutableSetOf<AudioRoute>()
        val mask = state.supportedRouteMask
        if (mask and CallAudioState.ROUTE_EARPIECE != 0) supported += AudioRoute.EARPIECE
        if (mask and CallAudioState.ROUTE_SPEAKER != 0) supported += AudioRoute.SPEAKER
        if (mask and CallAudioState.ROUTE_BLUETOOTH != 0) supported += AudioRoute.BLUETOOTH
        if (mask and CallAudioState.ROUTE_WIRED_HEADSET != 0) supported += AudioRoute.WIRED_HEADSET
        return AudioRouteSnapshot(
            isMuted = state.isMuted,
            route = route,
            supportedRoutes = supported,
        )
    }
}
