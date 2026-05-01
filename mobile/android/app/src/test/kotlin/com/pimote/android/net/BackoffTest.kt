package com.pimote.android.net

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

/**
 * Behavioral tests for [computeReconnectDelayMs] — the pure backoff schedule
 * used by [WsClient] reconnection.
 */
class BackoffTest {

    /** Fixed-output Random returning [next] every time, so jitter is deterministic. */
    private fun fixedRandom(next: Double) = object : Random() {
        override fun nextBits(bitCount: Int): Int = 0
        override fun nextDouble(): Double = next
    }

    @Test
    fun `attempt must be positive`() {
        assertThrows(IllegalArgumentException::class.java) {
            computeReconnectDelayMs(0, fixedRandom(0.5))
        }
        assertThrows(IllegalArgumentException::class.java) {
            computeReconnectDelayMs(-3, fixedRandom(0.5))
        }
    }

    @Test
    fun `first attempt uses base delay with no jitter when random is midpoint`() {
        // nextDouble == 0.5 → offset == 0.0, so delay equals base = 500ms.
        val d = computeReconnectDelayMs(1, fixedRandom(0.5), baseMs = 500, maxMs = 30_000)
        assertEquals(500L, d)
    }

    @Test
    fun `exponential growth doubles per attempt before saturation`() {
        val r = fixedRandom(0.5) // no jitter
        assertEquals(500L, computeReconnectDelayMs(1, r))
        assertEquals(1000L, computeReconnectDelayMs(2, r))
        assertEquals(2000L, computeReconnectDelayMs(3, r))
        assertEquals(4000L, computeReconnectDelayMs(4, r))
        assertEquals(8000L, computeReconnectDelayMs(5, r))
        assertEquals(16000L, computeReconnectDelayMs(6, r))
    }

    @Test
    fun `delay saturates at maxMs`() {
        val r = fixedRandom(0.5)
        // 500 * 2^6 = 32000 > 30000 → clamps.
        assertEquals(30_000L, computeReconnectDelayMs(7, r))
        // Far beyond saturation point still clamps.
        assertEquals(30_000L, computeReconnectDelayMs(50, r))
        assertEquals(30_000L, computeReconnectDelayMs(1000, r))
    }

    @Test
    fun `jitter at upper bound increases delay by jitterFraction`() {
        val r = fixedRandom(1.0) // offset == +jitterMag
        // base attempt 1 = 500, +20% = 600.
        assertEquals(600L, computeReconnectDelayMs(1, r, jitterFraction = 0.20))
    }

    @Test
    fun `jitter at lower bound reduces delay by jitterFraction`() {
        val r = fixedRandom(0.0) // offset == -jitterMag
        // base attempt 1 = 500, -20% = 400.
        assertEquals(400L, computeReconnectDelayMs(1, r, jitterFraction = 0.20))
    }

    @Test
    fun `delay is never negative`() {
        // Even with maximum negative jitter at the smallest base, must clamp at 0.
        val r = fixedRandom(0.0)
        val d = computeReconnectDelayMs(1, r, baseMs = 1L, jitterFraction = 5.0)
        assertTrue(d >= 0L, "expected non-negative delay, was $d")
    }

    @Test
    fun `bounded delay always within base + or - jitter even with random source`() {
        // Sweep many random values and check the bounds hold for the saturated case.
        val baseMs = 500L
        val maxMs = 30_000L
        val jitter = 0.20
        val rnd = Random(42)
        repeat(500) {
            val attempt = (1..40).random(rnd)
            val d = computeReconnectDelayMs(attempt, rnd, baseMs, maxMs, jitter)
            assertTrue(d >= 0L)
            assertTrue(d <= (maxMs * (1.0 + jitter)).toLong() + 1)
        }
    }
}
