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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.jsonObject
import java.util.concurrent.ConcurrentHashMap
import com.pimote.android.util.L

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
 * No attempt cap. A network-availability (false→true) edge cancels the current
 * backoff delay for an immediate retry and resets `attempt` to 0, so a fresh
 * failure after reconnecting restarts the schedule from the base delay.
 */
interface WsClient {
    val state: StateFlow<WsState>
    val events: SharedFlow<PimoteEvent>
    /** Most recent transport failure message, or `null` if never failed since the last successful connect. */
    val lastFailure: StateFlow<String?>

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
    private val _lastFailure = MutableStateFlow<String?>(null)

    override val state: StateFlow<WsState> = _state.asStateFlow()
    override val events: SharedFlow<PimoteEvent> = _events.asSharedFlow()
    override val lastFailure: StateFlow<String?> = _lastFailure.asStateFlow()

    /**
     * All per-connect()-call lifetime state, held as an immutable record
     * inside a single [MutableStateFlow]. When the slot is non-null the
     * client is actively trying to maintain a connection; when null the
     * client is fully disconnected.
     *
     * [scope] is a child of the constructor-injected scope. Every coroutine
     * the client runs while connected (the connection loop, the retry-wake
     * watcher) is launched into this scope, so [disconnect] just cancels it
     * and everything stops together — no more manual juggling of three
     * separate Job handles. [activeSocket] is the currently-open transport
     * connection, or null between attempts. Reads from [send] go through
     * this so the value is visible across threads without ad-hoc @Volatile.
     */
    private data class Session(
        val origin: String,
        val scope: CoroutineScope,
        val activeSocket: MutableStateFlow<WsTransport.Connection?>,
        /**
         * In-flight request map, scoped to THIS connect() lifetime. Previously
         * client-wide, which let a dying loop's tail `failAllPending()` fail
         * requests issued against the *next* session. Per-session, the old
         * loop only ever fails its own requests. (M3)
         */
        val pending: ConcurrentHashMap<String, CompletableDeferred<PimoteResponse>> = ConcurrentHashMap(),
    )

    private val session = MutableStateFlow<Session?>(null)

    @Synchronized
    override fun connect(pimoteOrigin: String) {
        val current = session.value
        if (current != null && current.origin == pimoteOrigin) return
        L.i("WS", "connect(origin=$pimoteOrigin)")
        closeSession(current, failPending = true)
        val sessionScope = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
        val fresh = Session(
            origin = pimoteOrigin,
            scope = sessionScope,
            activeSocket = MutableStateFlow(null),
        )
        session.value = fresh
        val url = wsUrl(pimoteOrigin)
        sessionScope.launch(start = CoroutineStart.UNDISPATCHED) { connectionLoop(fresh, url) }
    }

    @Synchronized
    override fun disconnect() {
        L.i("WS", "disconnect()")
        closeSession(session.value, failPending = true)
        session.value = null
        _state.value = WsState.Disconnected
    }

    /**
     * Single-source-of-truth helper for releasing a [Session]: close the
     * active socket, cancel the session's scope (which kills the connection
     * loop and any nested coroutines), and optionally fail in-flight
     * requests. Called by both [connect] (when reconfiguring origin) and
     * [disconnect] so the close sequence cannot drift between sites.
     */
    private fun closeSession(target: Session?, failPending: Boolean) {
        if (target == null) return
        try { target.activeSocket.value?.close() } catch (_: Throwable) { }
        target.activeSocket.value = null
        target.scope.cancel()
        if (failPending) failAllPending(target)
    }

    /**
     * Write [s] into the public state flow only if [target] is still the
     * current session. Stops a just-cancelled loop's non-suspending tail
     * (e.g. `waitForRetry` setting Reconnecting) from clobbering a newer
     * session's state. (M3)
     */
    private fun setState(target: Session, s: WsState) {
        if (session.value === target) _state.value = s
    }

    /**
     * The connection loop. [attempt] is a local rather than a controller
     * field — nothing outside the loop reads it. Wake-on-network is a child
     * coroutine of the retry delay, not a separate top-level coroutine.
     *
     * Reads [Session.activeSocket] via the session passed in; never reaches
     * for a controller field. Cancellation of [Session.scope] terminates
     * this coroutine; that is the sole disconnect signal — the old
     * `disconnected: Boolean` flag is gone.
     */
    private suspend fun connectionLoop(target: Session, url: String) {
        var attempt = 0
        var firstIter = true
        while (true) {
            if (firstIter) {
                setState(target, WsState.Connecting)
                L.d("WS", "connecting -> $url")
            }
            firstIter = false
            val conn: WsTransport.Connection = try {
                transport.open(url)
            } catch (e: Throwable) {
                L.w("WS", "transport.open failed: ${e.message}", e)
                _lastFailure.value = e.message ?: e::class.java.simpleName
                attempt = waitForRetry(target, attempt)
                continue
            }
            target.activeSocket.value = conn
            try {
                conn.events.collect { ev ->
                    when (ev) {
                        is WsTransport.Event.Open -> {
                            attempt = 0
                            setState(target, WsState.Connected)
                            _lastFailure.value = null
                            L.i("WS", "connected")
                        }
                        is WsTransport.Event.TextMessage -> handleMessage(target, ev.payload)
                        is WsTransport.Event.Closed -> {
                            _lastFailure.value = "closed: code=${ev.code} reason=${ev.reason}"
                            L.w("WS", "closed code=${ev.code} reason=${ev.reason}")
                            throw EndOfConnection
                        }
                        is WsTransport.Event.Failed -> {
                            _lastFailure.value = ev.reason
                            L.w("WS", "failed: ${ev.reason}")
                            throw EndOfConnection
                        }
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
            // Clear iff still ours (a concurrent disconnect may have nulled it).
            target.activeSocket.compareAndSet(conn, null)
            failAllPending(target)
            attempt = waitForRetry(target, attempt)
        }
    }

    /**
     * Sleep the next backoff delay, returning early if the network monitor
     * reports availability flipping false→true. Returns the incremented
     * attempt counter for the caller's next iteration.
     */
    private suspend fun waitForRetry(target: Session, currentAttempt: Int): Int {
        val next = currentAttempt + 1
        val d = computeReconnectDelayMs(next, random)
        L.d("WS", "reconnect attempt=$next delay=${d}ms")
        setState(target, WsState.Reconnecting(next, d))
        var wokeByNetwork = false
        coroutineScope {
            val delayJob = launch { delay(d) }
            val wakeJob = launch {
                // Wake early on a false→true edge so we don't sit on a long
                // backoff while connectivity has been restored.
                var prev: Boolean? = null
                networkMonitor.available
                    .filter { cur -> (prev == false && cur).also { prev = cur } }
                    .first()
                wokeByNetwork = true
                delayJob.cancel()
            }
            delayJob.join()
            wakeJob.cancel()
        }
        // A network-availability wake means connectivity was just restored, so
        // restart the backoff schedule (return attempt 0) per the documented
        // contract — otherwise a single post-wake failure would jump straight to
        // the 30s cap instead of the base delay. A normal delay expiry keeps
        // incrementing. (M4)
        return if (wokeByNetwork) 0 else next
    }

    private suspend fun handleMessage(target: Session, payload: String) {
        val element = try { json.parseToJsonElement(payload) } catch (_: Throwable) { return }
        val obj = (element as? kotlinx.serialization.json.JsonObject) ?: element.jsonObject
        if (obj.containsKey("success")) {
            val resp = try {
                json.decodeFromJsonElement(PimoteResponse.serializer(), element)
            } catch (_: Throwable) { return }
            target.pending.remove(resp.id)?.complete(resp)
        } else {
            val ev = try {
                json.decodeFromJsonElement(PimoteEventSerializer, element)
            } catch (_: UnknownPimoteEventTypeException) { return } catch (_: Throwable) { return }
            _events.emit(ev)
        }
    }

    private fun failAllPending(target: Session) {
        val toFail = target.pending.values.toList()
        target.pending.clear()
        toFail.forEach { it.completeExceptionally(WsConnectionLost()) }
    }

    override suspend fun <T> request(
        command: PimoteCommand,
        responseSerializer: KSerializer<T>,
        timeoutMillis: Long,
    ): TypedResponse<T> {
        // Register the pending entry on the CURRENT session so a reconnect that
        // replaces the session fails THIS request via that session's
        // failAllPending, never a later session's. (M3)
        val sess = session.value ?: throw WsConnectionLost("not connected")
        val def = CompletableDeferred<PimoteResponse>()
        sess.pending[command.id] = def
        try {
            send(command)
        } catch (e: Throwable) {
            sess.pending.remove(command.id)
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
            sess.pending.remove(command.id)
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
        val conn = session.value?.activeSocket?.value ?: throw WsConnectionLost("not connected")
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
