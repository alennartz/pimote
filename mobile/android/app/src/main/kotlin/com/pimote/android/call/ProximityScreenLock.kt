package com.pimote.android.call

import android.content.Context
import android.os.PowerManager
import com.pimote.android.util.L

/**
 * Decides whether the proximity-to-ear screen-off wake lock should be held,
 * given the current call state and audio routing.
 *
 * We blank the screen (to prevent cheek/ear touches) only when the call is
 * genuinely held to the head — i.e. it is [CallState.Active] AND the audio is
 * coming out of the earpiece. When the user is on speakerphone, a Bluetooth
 * device (incl. Android Auto), or a wired headset, the phone is not at the ear,
 * so we keep the screen on.
 *
 * `route == null` during an Active call is treated as earpiece: a fresh
 * self-managed call defaults to the earpiece before Telecom emits its first
 * `onCallAudioStateChanged`, and that is exactly the at-the-ear case.
 *
 * Pure function so it can be unit-tested without any Android framework.
 */
fun shouldHoldProximityLock(
    state: CallState,
    route: AudioRouteSnapshot?,
    speakerOn: Boolean,
): Boolean {
    if (state !is CallState.Active) return false
    if (speakerOn) return false
    return when (route?.route) {
        null, AudioRoute.EARPIECE -> true
        AudioRoute.SPEAKER,
        AudioRoute.BLUETOOTH,
        AudioRoute.WIRED_HEADSET,
        AudioRoute.STREAMING -> false
    }
}

/**
 * Thin wrapper around a [PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK]. This is
 * the same mechanism the stock dialer uses: while held, the platform turns the
 * screen off whenever the proximity sensor reports an object close to it (the
 * user's ear) and turns it back on when clear.
 *
 * [apply] is idempotent — drive it off a state flow and it only touches the
 * underlying lock on actual edges.
 *
 * Constructed lazily by [com.pimote.android.app.AppContainer]; held for the
 * lifetime of the process (the wake lock itself is acquired/released per the
 * [shouldHoldProximityLock] policy).
 */
class ProximityScreenLock(context: Context) {
    private val powerManager =
        context.getSystemService(Context.POWER_SERVICE) as PowerManager

    private val supported: Boolean =
        powerManager.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)

    private val wakeLock: PowerManager.WakeLock? =
        if (supported) {
            powerManager.newWakeLock(
                PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK,
                "Pimote:ProximityCall",
            )
        } else {
            null
        }

    /** Acquire or release the proximity lock to match [hold]. Idempotent. */
    @Synchronized
    fun apply(hold: Boolean) {
        val lock = wakeLock ?: return
        if (hold && !lock.isHeld) {
            lock.acquire()
            L.i("Call", "proximity lock acquired")
        } else if (!hold && lock.isHeld) {
            // No timeout/flags arg: release and let the screen come back on.
            lock.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY)
            L.i("Call", "proximity lock released")
        }
    }
}
