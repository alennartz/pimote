package com.pimote.android.net

import com.pimote.android.protocol.PimoteCommand
import com.pimote.android.protocol.PimoteEvent
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.KSerializer

/**
 * High-level connection state surfaced by [WsClient]. Mirrored as a
 * UI-observable [StateFlow]; transitions are driven by the underlying socket.
 */
sealed interface WsState {
    /** Initial state and the state after explicit [WsClient.disconnect]. */
    object Disconnected : WsState
    object Connecting : WsState
    object Connected : WsState

    /**
     * The client is between connection attempts. [attempt] is 1-based,
     * [nextDelayMs] is the backoff delay before the next attempt fires (after
     * jitter). The schedule is `min(30_000, 500 * 2^(attempt-1))` with ±20%
     * jitter applied per attempt.
     */
    data class Reconnecting(val attempt: Int, val nextDelayMs: Long) : WsState

    /** Terminal failure surfaced for diagnostics; client may still recover. */
    data class Failed(val reason: String) : WsState
}

/** Thrown from suspended [WsClient.request] when the socket drops mid-call. */
class WsConnectionLost(message: String = "websocket connection lost") :
    RuntimeException(message)

/** Thrown from [WsClient.request] when no response arrives within the timeout. */
class WsRequestTimeout(message: String = "websocket request timed out") :
    RuntimeException(message)

/**
 * Thin wrapper around the server's typed [PimoteResponse]. The data slot is
 * decoded by the caller using a passed [KSerializer] for [T].
 */
data class TypedResponse<T>(
    val id: String,
    val success: Boolean,
    val data: T?,
    val error: String?,
)

/**
 * Pimote control connection. Always-on while the app is running; auto-reconnect
 * with exponential backoff + jitter, and an immediate reconnect when the OS
 * reports a network change.
 *
 * - WS endpoint is `${pimoteOrigin}/ws`. Wire format is JSON identical to the
 *   PWA — top-level message is either a [com.pimote.android.protocol.PimoteResponse]
 *   (object with `success` field) or a [PimoteEvent] (everything else,
 *   discriminated by `type`).
 * - [connect] is idempotent. If called with a different origin it tears down
 *   any existing socket and reconnects against the new origin.
 * - [disconnect] is the only way to stop the reconnect loop. Network blips,
 *   server-initiated closes, and unexpected drops all transition to
 *   [WsState.Reconnecting].
 * - In-flight [request] calls cancel with [WsConnectionLost] if the underlying
 *   socket drops before a response is received.
 *
 * Backoff schedule (ms): `min(30_000, 500 * 2^(attempt-1))` with ±20% jitter.
 * No attempt cap. Network-availability events reset `attempt` to 0 and trigger
 * an immediate retry.
 */
interface WsClient {
    val state: StateFlow<WsState>
    val events: SharedFlow<PimoteEvent>

    /**
     * Begin connecting to [pimoteOrigin] (e.g. `https://pimote.example.com`).
     * Idempotent: re-calling with the same origin is a no-op while already
     * connected/connecting; calling with a different origin reconfigures.
     */
    fun connect(pimoteOrigin: String)

    /** Permanently stop the reconnect loop. State transitions to [WsState.Disconnected]. */
    fun disconnect()

    /**
     * Send [command] and suspend until the matching [com.pimote.android.protocol.PimoteResponse]
     * arrives. The command's `id` is used to correlate. [responseSerializer] is
     * applied to the response's `data` slot; `null` data is permitted on a
     * `success: true` response with no payload.
     *
     * Throws [WsRequestTimeout] after [timeoutMillis], [WsConnectionLost] if the
     * socket drops first, or `kotlinx.coroutines.CancellationException` on
     * cooperative cancellation. A `success: false` response is returned (not
     * thrown) so callers can branch on [TypedResponse.error].
     */
    suspend fun <T> request(
        command: PimoteCommand,
        responseSerializer: KSerializer<T>,
        timeoutMillis: Long = 10_000,
    ): TypedResponse<T>

    /** Fire-and-forget command send; throws [WsConnectionLost] if not connected. */
    suspend fun send(command: PimoteCommand)
}
