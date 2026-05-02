package com.pimote.android.ui.call

import com.pimote.android.call.CallEndReason
import com.pimote.android.call.CallState
import com.pimote.android.ui.components.AvatarRingState

/**
 * Maps a [CallState] to the [AvatarRingState] the in-call screen displays.
 * [durationSeconds] is only used for [CallState.Active].
 */
fun deriveAvatarRingState(state: CallState, durationSeconds: Long = 0L): AvatarRingState =
    when (state) {
        CallState.Idle -> AvatarRingState.Connecting("Idle")
        is CallState.Dialing -> AvatarRingState.Connecting("Dialing\u2026")
        is CallState.Binding -> AvatarRingState.Connecting("Connecting\u2026")
        is CallState.Negotiating -> AvatarRingState.Connecting("Connecting\u2026")
        is CallState.Active -> AvatarRingState.Active(durationSeconds)
        is CallState.Ended -> when (state.reason) {
            CallEndReason.USER_HANGUP,
            CallEndReason.REMOTE_HANGUP,
            CallEndReason.DISPLACED,
            CallEndReason.SERVER_ENDED -> AvatarRingState.EndedOk
            CallEndReason.PEER_FAILED,
            CallEndReason.BIND_FAILED -> AvatarRingState.EndedError(describeEndReason(state.reason))
        }
    }

/** Formats a duration in seconds as `MM:SS`. Minutes may exceed 99. */
fun formatCallDuration(seconds: Long): String {
    val safe = if (seconds < 0) 0 else seconds
    val m = safe / 60
    val s = safe % 60
    return "%02d:%02d".format(m, s)
}

/** Human-readable label for a [CallEndReason], shared by the in-call screen and avatar ring. */
fun describeEndReason(r: CallEndReason): String = when (r) {
    CallEndReason.USER_HANGUP -> "Hung up"
    CallEndReason.REMOTE_HANGUP -> "Remote hung up"
    CallEndReason.DISPLACED -> "Displaced by another client"
    CallEndReason.SERVER_ENDED -> "Server ended call"
    CallEndReason.PEER_FAILED -> "Voice peer failed (signaling/ICE)"
    CallEndReason.BIND_FAILED -> "Could not bind call"
}
