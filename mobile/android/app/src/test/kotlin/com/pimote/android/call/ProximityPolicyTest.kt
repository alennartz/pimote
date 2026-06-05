package com.pimote.android.call

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ProximityPolicyTest {

    private fun snapshot(route: AudioRoute) = AudioRouteSnapshot(
        isMuted = false,
        route = route,
        supportedRoutes = setOf(route),
    )

    @Test
    fun `holds when active on earpiece`() {
        assertTrue(shouldHoldProximityLock(CallState.Active("s"), snapshot(AudioRoute.EARPIECE), false))
    }

    @Test
    fun `holds when active and route not yet reported`() {
        assertTrue(shouldHoldProximityLock(CallState.Active("s"), null, false))
    }

    @Test
    fun `releases on speakerphone even when route says earpiece`() {
        assertFalse(shouldHoldProximityLock(CallState.Active("s"), snapshot(AudioRoute.EARPIECE), true))
    }

    @Test
    fun `releases on bluetooth and wired headset`() {
        assertFalse(shouldHoldProximityLock(CallState.Active("s"), snapshot(AudioRoute.BLUETOOTH), false))
        assertFalse(shouldHoldProximityLock(CallState.Active("s"), snapshot(AudioRoute.WIRED_HEADSET), false))
    }

    @Test
    fun `releases when not active`() {
        assertFalse(shouldHoldProximityLock(CallState.Negotiating("s"), snapshot(AudioRoute.EARPIECE), false))
        assertFalse(shouldHoldProximityLock(CallState.Idle, null, false))
        assertFalse(shouldHoldProximityLock(CallState.Ended("s", CallEndReason.USER_HANGUP), snapshot(AudioRoute.EARPIECE), false))
    }
}

class CallNotificationTextTest {

    @Test
    fun `status text covers each state`() {
        assertEquals("Calling…", callNotificationStatusText(CallState.Dialing(SessionTarget.ExistingSession("s"))))
        assertEquals("Connecting…", callNotificationStatusText(CallState.Binding("s")))
        assertEquals("Connecting…", callNotificationStatusText(CallState.Negotiating("s")))
        assertEquals("Voice call", callNotificationStatusText(CallState.Active("s")))
        assertEquals("Call ended", callNotificationStatusText(CallState.Ended("s", CallEndReason.USER_HANGUP)))
    }
}
