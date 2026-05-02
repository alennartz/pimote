package com.pimote.android.ui.call

import com.pimote.android.call.CallEndReason
import com.pimote.android.call.CallState
import com.pimote.android.ui.components.AvatarRingState
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CallStateHelpersTest {

    @Test
    fun `derive Active maps to AvatarRingState Active with duration`() {
        val result = deriveAvatarRingState(CallState.Active("sess-1"), 75L)
        assertEquals(AvatarRingState.Active(75L), result)
    }

    @Test
    fun `derive Ended USER_HANGUP maps to EndedOk`() {
        val result = deriveAvatarRingState(CallState.Ended("sess-1", CallEndReason.USER_HANGUP))
        assertEquals(AvatarRingState.EndedOk, result)
    }

    @Test
    fun `derive Ended PEER_FAILED maps to EndedError with non-blank reason`() {
        val result = deriveAvatarRingState(CallState.Ended("sess-1", CallEndReason.PEER_FAILED))
        assertTrue(result is AvatarRingState.EndedError)
        result as AvatarRingState.EndedError
        assertTrue(result.reason.isNotBlank())
    }

    @Test
    fun `formatCallDuration zero`() {
        assertEquals("00:00", formatCallDuration(0L))
    }

    @Test
    fun `formatCallDuration 75 seconds`() {
        assertEquals("01:15", formatCallDuration(75L))
    }

    @Test
    fun `formatCallDuration 3661 seconds`() {
        assertEquals("61:01", formatCallDuration(3661L))
    }
}
