package com.pimote.android.net

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Production [WsTransport] backed by OkHttp. Each [open] returns a
 * [WsTransport.Connection] whose events flow is pumped by an
 * [okhttp3.WebSocketListener].
 */
class OkHttpWsTransport(
    private val client: OkHttpClient = OkHttpClient(),
) : WsTransport {
    override fun open(url: String): WsTransport.Connection = OkHttpConnection(client, url)
}

private class OkHttpConnection(
    private val client: OkHttpClient,
    private val url: String,
) : WsTransport.Connection {

    @Volatile private var socket: WebSocket? = null

    override val events: Flow<WsTransport.Event> = callbackFlow {
        // Use trySendBlocking (not trySend): if the collector falls behind and
        // the channel fills, blocking the OkHttp listener thread applies
        // backpressure rather than silently dropping frames — dropped frames
        // include command responses, which would surface as spurious
        // WsRequestTimeouts. OkHttp listener threads tolerate blocking. (L4)
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                trySendBlocking(WsTransport.Event.Open)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                trySendBlocking(WsTransport.Event.TextMessage(text))
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                trySendBlocking(WsTransport.Event.Closed(code, reason))
                close()
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                trySendBlocking(WsTransport.Event.Failed(t.message ?: t::class.java.simpleName))
                close()
            }
        }
        val ws = client.newWebSocket(Request.Builder().url(url).build(), listener)
        socket = ws
        awaitClose {
            try { ws.close(1000, "client closed") } catch (_: Throwable) { }
        }
    }

    override fun send(text: String): Boolean = socket?.send(text) ?: false

    override fun close(code: Int, reason: String?) {
        socket?.close(code, reason ?: "")
    }
}
