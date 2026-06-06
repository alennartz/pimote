package com.pimote.android.telephony

/**
 * App-side abstraction over [android.telecom.Connection], consumed by
 * [com.pimote.android.call.CallController]. Production: implemented by
 * [PimoteConnection], which forwards each call to the framework. Tests:
 * implemented by a fake.
 *
 * The Telecom framework only knows about the underlying [android.telecom.Connection];
 * this interface exists purely as a unit-test seam so the call-state-machine
 * logic can be exercised without spinning up Telecom.
 */
interface CallConnection {
    /** Move Telecom to "ringing" (`setRinging()`). */
    fun markRinging()

    /** Move Telecom to "active" (`setActive()`). */
    fun markActive()

    /** Move Telecom to disconnected with an ERROR cause and destroy. */
    fun markFailed(reason: String)

    /** Move Telecom to disconnected with the appropriate end cause and destroy. */
    fun markEndedRemotely(reason: com.pimote.android.call.CallEndReason)

    /**
     * Move Telecom to disconnected with a LOCAL cause and destroy. Used when the
     * user hangs up from inside the app (in-call screen, persistent
     * notification, pre-Active cancel). The single place [CallController] tells
     * Telecom that an app-initiated end has fully torn the call down — without
     * it the self-managed `Connection` stays alive, the system stays in
     * `MODE_IN_COMMUNICATION`, and the mic remains unavailable to other apps.
     */
    fun markEndedLocally()

    /**
     * Request a route change on the underlying [android.telecom.Connection].
     * No-op if the requested route isn't in the current supported mask;
     * Telecom will emit an `onCallAudioStateChanged` callback if it accepts.
     */
    fun setAudioRoute(route: com.pimote.android.call.AudioRoute)
}
