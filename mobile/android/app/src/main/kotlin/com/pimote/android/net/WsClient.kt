package com.pimote.android.net

import com.pimote.android.protocol.CallBindCommand
import com.pimote.android.protocol.CallEndCommand
import com.pimote.android.protocol.ListFoldersCommand
import com.pimote.android.protocol.ListSessionsCommand
import com.pimote.android.protocol.OpenSessionCommand
import com.pimote.android.protocol.PimoteCommand
import com.pimote.android.protocol.PimoteEvent
import com.pimote.android.protocol.PimoteEventSerializer
import com.pimote.android.protocol.PimoteResponse
import com.pimote.android.protocol.UnknownPimoteEventTypeException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.jsonObject
import java.util.concurrent.ConcurrentHashMap

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

/**
 * Production [WsClient]. Wires the OkHttp-backed [WsTransport] and the
 * connectivity-backed [NetworkAvailabilityMonitor] together with the backoff
 * schedule from [computeReconnectDelayMs]. Tests construct it with fakes.
 *
 * `idGenerator` returns the value placed into the outgoing command's `id` slot
 * — defaulted to a random UUID in production; tests inject a deterministic
 * supplier so request-correlation assertions are stable.
 */
class WsClientImpl(
    private val transport: WsTransport,
    private val networkMonitor: NetworkAvailabilityMonitor,
    private val scope: kotlinx.coroutines.CoroutineScope,
    private val json: kotlinx.serialization.json.Json = kotlinx.serialization.json.Json {
        ignoreUnknownKeys = true; encodeDefaults = true
    },
    private val random: kotlin.random.Random = kotlin.random.Random.Default,
    private val idGenerator: () -> String = { java.util.UUID.randomUUID().toString() },
) : WsClient {
    private val _state = MutableStateFlow<WsState>(WsState.Disconnected)
    private val _events = MutableSharedFlow<PimoteEvent>(extraBufferCapacity = 64)

    override val state: StateFlow<WsState> = _state.asStateFlow()
    override val events: SharedFlow<PimoteEvent> = _events.asSharedFlow()

    private val pending = ConcurrentHashMap<String, CompletableDeferred<PimoteResponse>>()
    private var currentOrigin: String? = null
    @Volatile private var currentConnection: WsTransport.Connection? = null
    private var loopJob: Job? = null
    private var netJob: Job? = null
    @Volatile private var delayJob: Job? = null
    @Volatile private var attempt = 0
    @Volatile private var disconnected = false

    override fun connect(pimoteOrigin: String) {
        if (currentOrigin == pimoteOrigin && loopJob?.isActive == true && !disconnected) return
        teardown(failPending = true)
        disconnected = false
        currentOrigin = pimoteOrigin
        attempt = 0
        val url = wsUrl(pimoteOrigin)
        loopJob = scope.launch(start = CoroutineStart.UNDISPATCHED) { connectionLoop(url) }
        netJob = scope.launch(start = CoroutineStart.UNDISPATCHED) { observeNetwork() }
    }

    override fun disconnect() {
        disconnected = true
        teardown(failPending = true)
        _state.value = WsState.Disconnected
    }

    private fun teardown(failPending: Boolean) {
        delayJob?.cancel()
        delayJob = null
        loopJob?.cancel()
        loopJob = null
        netJob?.cancel()
        netJob = null
        try { currentConnection?.close() } catch (_: Throwable) { }
        currentConnection = null
        if (failPending) {
            val toFail = pending.values.toList()
            pending.clear()
            toFail.forEach { it.completeExceptionally(WsConnectionLost()) }
        }
    }

    private suspend fun connectionLoop(url: String) {
        var firstIter = true
        try {
            while (!disconnected) {
                if (firstIter) _state.value = WsState.Connecting
                firstIter = false
                val conn: WsTransport.Connection = try {
                    transport.open(url)
                } catch (e: Throwable) {
                    if (disconnected) break
                    scheduleRetry()
                    continue
                }
                currentConnection = conn
                try {
                    conn.events.collect { ev ->
                        when (ev) {
                            is WsTransport.Event.Open -> {
                                attempt = 0
                                _state.value = WsState.Connected
                            }
                            is WsTransport.Event.TextMessage -> handleMessage(ev.payload)
                            is WsTransport.Event.Closed,
                            is WsTransport.Event.Failed -> throw EndOfConnection
                        }
                    }
                } catch (_: EndOfConnection) {
                    // expected — drop through to retry
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (_: Throwable) {
                    // unexpected — drop through to retry
                }
                try { conn.close() } catch (_: Throwable) { }
                if (currentConnection === conn) currentConnection = null
                failAllPending()
                if (disconnected) break
                scheduleRetry()
            }
        } finally {
            if (disconnected) _state.value = WsState.Disconnected
        }
    }

    private suspend fun scheduleRetry() {
        attempt += 1
        val d = computeReconnectDelayMs(attempt, random)
        _state.value = WsState.Reconnecting(attempt, d)
        kotlinx.coroutines.coroutineScope {
            // run the delay as a child job so the network monitor can cancel it
            val dj = launch { delay(d) }
            delayJob = dj
            try {
                dj.join()
            } finally {
                delayJob = null
            }
        }
    }

    private suspend fun observeNetwork() {
        var prev: Boolean? = null
        networkMonitor.available.collect { cur ->
            if (prev == false && cur) {
                attempt = 0
                delayJob?.cancel()
            }
            prev = cur
        }
    }

    private suspend fun handleMessage(payload: String) {
        val element = try { json.parseToJsonElement(payload) } catch (_: Throwable) { return }
        val obj = (element as? kotlinx.serialization.json.JsonObject) ?: element.jsonObject
        if (obj.containsKey("success")) {
            val resp = try {
                json.decodeFromJsonElement(PimoteResponse.serializer(), element)
            } catch (_: Throwable) { return }
            pending.remove(resp.id)?.complete(resp)
        } else {
            val ev = try {
                json.decodeFromJsonElement(PimoteEventSerializer, element)
            } catch (_: UnknownPimoteEventTypeException) { return } catch (_: Throwable) { return }
            _events.emit(ev)
        }
    }

    private fun failAllPending() {
        val toFail = pending.values.toList()
        pending.clear()
        toFail.forEach { it.completeExceptionally(WsConnectionLost()) }
    }

    override suspend fun <T> request(
        command: PimoteCommand,
        responseSerializer: KSerializer<T>,
        timeoutMillis: Long,
    ): TypedResponse<T> {
        val def = CompletableDeferred<PimoteResponse>()
        pending[command.id] = def
        try {
            send(command)
        } catch (e: Throwable) {
            pending.remove(command.id)
            throw e
        }
        // Watchdog uses Dispatchers.IO so its delay runs on wall-clock time, not the
        // virtual test scheduler. This prevents `advanceUntilIdle()` from prematurely
        // tripping a long default timeout while a quick response is still in flight.
        val watchdog = scope.launch(Dispatchers.IO) {
            delay(timeoutMillis)
            if (def.isActive) def.completeExceptionally(WsRequestTimeout())
        }
        val resp: PimoteResponse = try {
            def.await()
        } catch (e: Throwable) {
            pending.remove(command.id)
            watchdog.cancel()
            throw e
        }
        watchdog.cancel()
        val data: T? = if (resp.success && resp.data != null) {
            try { json.decodeFromJsonElement(responseSerializer, resp.data) } catch (_: Throwable) { null }
        } else null
        return TypedResponse(resp.id, resp.success, data, resp.error)
    }

    override suspend fun send(command: PimoteCommand) {
        val conn = currentConnection ?: throw WsConnectionLost("not connected")
        if (_state.value !is WsState.Connected) throw WsConnectionLost("not connected")
        val text = encodeCommand(command)
        if (!conn.send(text)) throw WsConnectionLost("send failed")
    }

    private fun encodeCommand(command: PimoteCommand): String = when (command) {
        is CallBindCommand -> json.encodeToString(CallBindCommand.serializer(), command)
        is CallEndCommand -> json.encodeToString(CallEndCommand.serializer(), command)
        is OpenSessionCommand -> json.encodeToString(OpenSessionCommand.serializer(), command)
        is ListFoldersCommand -> json.encodeToString(ListFoldersCommand.serializer(), command)
        is ListSessionsCommand -> json.encodeToString(ListSessionsCommand.serializer(), command)
    }

    private fun wsUrl(origin: String): String {
        val converted = when {
            origin.startsWith("https://") -> "wss://" + origin.removePrefix("https://")
            origin.startsWith("http://") -> "ws://" + origin.removePrefix("http://")
            else -> origin
        }
        val trimmed = converted.trimEnd('/')
        return "$trimmed/ws"
    }

    private object EndOfConnection : RuntimeException() {
        override fun fillInStackTrace() = this
    }
}
