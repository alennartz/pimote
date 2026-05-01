package com.pimote.android.net

import kotlin.math.min
import kotlin.random.Random

/**
 * Exponential backoff schedule with bounded jitter, used by [WsClient]
 * reconnection.
 *
 * Pure function — no clock, no coroutine. Given the 1-based [attempt] number
 * (1 = first retry after the first drop) and a [random] source, returns the
 * delay in milliseconds before the next attempt fires.
 *
 * Schedule:
 *   base = min(maxMs, baseMs * 2^(attempt - 1))
 *   delay = base ± (jitterFraction * base)
 *
 * Defaults match the architecture (`min(30_000, 500 * 2^(attempt-1)) ± 20%`).
 *
 * Contract:
 * - [attempt] >= 1.
 * - Returned value is non-negative and ≤ maxMs * (1 + jitterFraction).
 * - At [attempt] == 1, base equals [baseMs].
 * - Beyond the saturation point base equals [maxMs] regardless of how many
 *   further attempts accumulate.
 */
fun computeReconnectDelayMs(
    attempt: Int,
    random: Random = Random.Default,
    baseMs: Long = 500L,
    maxMs: Long = 30_000L,
    jitterFraction: Double = 0.20,
): Long {
    require(attempt >= 1) { "attempt must be >= 1, was $attempt" }
    // 2^(attempt-1) saturates safely in long arithmetic; use a clamped shift.
    val shift = (attempt - 1).coerceAtMost(31)
    val raw = baseMs.toDouble() * (1L shl shift)
    val base = min(maxMs.toDouble(), raw)
    val jitterMag = base * jitterFraction
    val offset = (random.nextDouble() * 2.0 - 1.0) * jitterMag
    val delay = (base + offset).toLong()
    return delay.coerceAtLeast(0L)
}
