package com.pimote.android.net

import kotlinx.coroutines.flow.Flow

/**
 * Test seam over the real WebSocket transport (OkHttp in production).
 *
 * Production: a thin OkHttp adapter the [WsClient] implementation uses to
 * open / close / send. Tests: an in-memory fake whose script of messages
 * and close events drives the client through deterministic transitions.
 *
 * The interface deliberately avoids OkHttp types so unit tests don't need
 * the framework on the test classpath.
 */
interface WsTransport {

    /** Events surfaced by a single connection attempt. */
    sealed interface Event {
        /** Underlying socket has opened. */
        object Open : Event
        /** Server sent a text frame. */
        data class TextMessage(val payload: String) : Event
        /** Connection closed cleanly with a status code. */
        data class Closed(val code: Int, val reason: String?) : Event
        /** Connection failed before or after open. */
        data class Failed(val reason: String) : Event
    }

    /** Live handle to a single connection attempt. */
    interface Connection {
        /** Cold-on-collect flow of socket events. Completes when the connection is gone. */
        val events: Flow<Event>

        /** Send a UTF-8 text frame. Returns false if the socket is no longer writable. */
        fun send(text: String): Boolean

        /** Initiate close from our side with a clean status. */
        fun close(code: Int = 1000, reason: String? = null)
    }

    /** Open a new connection to [url]. The returned [Connection] starts in pending state. */
    fun open(url: String): Connection
}

/** Test seam over [android.net.ConnectivityManager]. */
interface NetworkAvailabilityMonitor {
    /** Cold flow that emits true when a usable network appears, false when none is available. */
    val available: Flow<Boolean>
}
