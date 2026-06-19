package com.pimote.android.net

import com.pimote.android.protocol.CallBindCommand
import com.pimote.android.protocol.CallBindResponseData
import com.pimote.android.protocol.CallReadyEvent
import com.pimote.android.protocol.PimoteEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

/**
 * Behavioral tests for [WsClientImpl]. The implementation is exercised
 * through the [WsTransport] and [NetworkAvailabilityMonitor] test seams so
 * the test runs as pure JVM \u2014 no OkHttp, no `ConnectivityManager`.
 *
 * The brainstorm explicitly named "wait 16 s after coming back into wifi
 * range" as the failure mode the network-aware reset is designed to prevent;
 * those behaviors are pinned here.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class WsClientTest {

    /** Hand-rolled in-memory WsTransport. Each open() returns a controllable connection. */
    private class FakeWsTransport : WsTransport {
        val opens = mutableListOf<String>()
        val connections = ArrayDeque<FakeConnection>()
        /** Pre-seed connections so each `open()` consumes one in order. */
        fun nextConnection(): FakeConnection {
            val c = FakeConnection()
            connections.addLast(c)
            return c
        }
        override fun open(url: String): WsTransport.Connection {
            opens.add(url)
            return connections.removeFirst()
        }
    }

    private class FakeConnection : WsTransport.Connection {
        val sent = mutableListOf<String>()
        var closed = false
        private val flow = MutableSharedFlow<WsTransport.Event>(extraBufferCapacity = 32)
        override val events = flow.asSharedFlow()
        override fun send(text: String): Boolean {
            if (closed) return false
            sent.add(text); return true
        }
        override fun close(code: Int, reason: String?) {
            closed = true
        }
        suspend fun emit(ev: WsTransport.Event) = flow.emit(ev)
    }

    private class FakeNetworkMonitor : NetworkAvailabilityMonitor {
        private val flow = MutableSharedFlow<Boolean>(replay = 1, extraBufferCapacity = 8)
        override val available = flow
        suspend fun emit(v: Boolean) = flow.emit(v)
    }

    private fun fixedIds(vararg ids: String): () -> String {
        val q = ArrayDeque(ids.toList()); return { q.removeFirst() }
    }

    @Test
    fun `request correlates response by id`() = runTest {
        val transport = FakeWsTransport()
        val conn = transport.nextConnection()
        val net = FakeNetworkMonitor().apply { emit(true) }
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val client = WsClientImpl(transport, net, scope, random = Random(0), idGenerator = fixedIds("R1"))

        client.connect("https://pimote.example.com")
        advanceUntilIdle()
        conn.emit(WsTransport.Event.Open)
        advanceUntilIdle()

        val deferred = scope.async {
            client.request(
                CallBindCommand(id = "R1", sessionId = "S"),
                CallBindResponseData.serializer(),
            )
        }
        advanceUntilIdle()

        // The command went out on the wire with id=R1.
        assertTrue(conn.sent.any { it.contains("\"id\":\"R1\"") && it.contains("\"call_bind\"") })

        // Server responds.
        conn.emit(
            WsTransport.Event.TextMessage(
                """{"id":"R1","success":true,"data":{"sessionId":"S","webrtcSignalUrl":"wss://x"}}""",
            ),
        )
        advanceUntilIdle()

        val resp = deferred.await()
        assertEquals(true, resp.success)
        assertEquals("S", resp.data?.sessionId)
    }

    @Test
    fun `request times out`() = runTest {
        val transport = FakeWsTransport()
        val conn = transport.nextConnection()
        val net = FakeNetworkMonitor().apply { emit(true) }
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val client = WsClientImpl(transport, net, scope, idGenerator = fixedIds("T1"))
        client.connect("https://pimote.example.com")
        conn.emit(WsTransport.Event.Open)
        advanceUntilIdle()

        val def = scope.async {
            runCatching {
                client.request(
                    CallBindCommand(id = "T1", sessionId = "S"),
                    CallBindResponseData.serializer(),
                    timeoutMillis = 100,
                )
            }
        }
        advanceTimeBy(150)
        advanceUntilIdle()
        val r = def.await()
        assertTrue(r.isFailure)
        assertTrue(r.exceptionOrNull() is WsRequestTimeout)
    }

    @Test
    fun `in-flight request fails with WsConnectionLost on socket drop`() = runTest {
        val transport = FakeWsTransport()
        val conn = transport.nextConnection()
        transport.nextConnection() // for the auto-reconnect
        val net = FakeNetworkMonitor().apply { emit(true) }
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val client = WsClientImpl(transport, net, scope, idGenerator = fixedIds("C1"))
        client.connect("https://pimote.example.com")
        conn.emit(WsTransport.Event.Open)
        advanceUntilIdle()

        val def = scope.async {
            runCatching {
                client.request(
                    CallBindCommand(id = "C1", sessionId = "S"),
                    CallBindResponseData.serializer(),
                )
            }
        }
        advanceUntilIdle()

        conn.emit(WsTransport.Event.Closed(1006, "drop"))
        advanceUntilIdle()
        val r = def.await()
        assertTrue(r.isFailure)
        assertTrue(r.exceptionOrNull() is WsConnectionLost)
    }

    @Test
    fun `events flow surfaces server events`() = runTest {
        val transport = FakeWsTransport()
        val conn = transport.nextConnection()
        val net = FakeNetworkMonitor().apply { emit(true) }
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val client = WsClientImpl(transport, net, scope)
        client.connect("https://pimote.example.com")
        conn.emit(WsTransport.Event.Open)
        advanceUntilIdle()

        val collected = mutableListOf<PimoteEvent>()
        val job = scope.launch { client.events.collect { collected.add(it) } }
        advanceUntilIdle()

        conn.emit(WsTransport.Event.TextMessage("""{"type":"call_ready","sessionId":"S"}"""))
        advanceUntilIdle()

        assertTrue(collected.any { it is CallReadyEvent && it.sessionId == "S" })
        job.cancel()
    }

    @Test
    fun `unexpected close transitions to Reconnecting with attempt counter`() = runTest {
        val transport = FakeWsTransport()
        val conn = transport.nextConnection()
        transport.nextConnection() // next attempt
        val net = FakeNetworkMonitor().apply { emit(true) }
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val client = WsClientImpl(transport, net, scope, random = Random(0))
        client.connect("https://pimote.example.com")
        conn.emit(WsTransport.Event.Open)
        advanceUntilIdle()
        assertEquals(WsState.Connected, client.state.value)

        conn.emit(WsTransport.Event.Closed(1006, "drop"))
        advanceUntilIdle()

        val s = client.state.value
        assertTrue(s is WsState.Reconnecting, "state was $s")
        s as WsState.Reconnecting
        assertEquals(1, s.attempt)
        assertTrue(s.nextDelayMs >= 0)
    }

    @Test
    fun `surfaces Failed after repeated consecutive failures and recovers to Connected`() = runTest {
        val transport = FakeWsTransport()
        val c1 = transport.nextConnection()
        val c2 = transport.nextConnection()
        val c3 = transport.nextConnection()
        val c4 = transport.nextConnection()
        val net = FakeNetworkMonitor().apply { emit(true) }
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val client = WsClientImpl(transport, net, scope, random = Random(0))
        client.connect("https://pimote.example.com")
        advanceUntilIdle()

        // First two failures stay in Reconnecting (transient drops shouldn't alarm).
        c1.emit(WsTransport.Event.Failed("dns-1"))
        advanceUntilIdle()
        assertTrue(client.state.value is WsState.Reconnecting, "after 1 failure: ${client.state.value}")

        c2.emit(WsTransport.Event.Failed("dns-2"))
        advanceUntilIdle()
        assertTrue(client.state.value is WsState.Reconnecting, "after 2 failures: ${client.state.value}")

        // Third consecutive failure surfaces Failed (with the latest reason).
        c3.emit(WsTransport.Event.Failed("dns-3"))
        advanceUntilIdle()
        val failed = client.state.value
        assertTrue(failed is WsState.Failed, "after 3 failures: $failed")
        failed as WsState.Failed
        assertEquals("dns-3", failed.reason)

        // Not terminal: a subsequent successful open returns to Connected.
        c4.emit(WsTransport.Event.Open)
        advanceUntilIdle()
        assertEquals(WsState.Connected, client.state.value)
    }

    @Test
    fun `network availability resumes immediately resetting backoff`() = runTest {
        val transport = FakeWsTransport()
        val first = transport.nextConnection()
        val second = transport.nextConnection()
        val third = transport.nextConnection()
        val net = FakeNetworkMonitor().apply { emit(true) }
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val client = WsClientImpl(transport, net, scope, random = Random(0))
        client.connect("https://pimote.example.com")
        first.emit(WsTransport.Event.Open)
        advanceUntilIdle()

        // Drop and let backoff schedule a far-out attempt by simulating multiple failures.
        first.emit(WsTransport.Event.Closed(1006, "drop"))
        advanceUntilIdle()
        // The reconnect attempt picks up `second`. Make it fail again to bump attempts.
        second.emit(WsTransport.Event.Failed("dns"))
        advanceUntilIdle()
        val before = (client.state.value as? WsState.Reconnecting)?.attempt ?: -1
        assertTrue(before >= 1)

        // Now the OS reports network availability \u2014 must reset backoff and reconnect immediately.
        net.emit(false)
        net.emit(true)
        advanceUntilIdle()

        // We should have opened a new (third) connection without waiting out the schedule.
        assertTrue(transport.opens.size >= 3, "expected immediate reopen, opens=${transport.opens.size}")
        third.emit(WsTransport.Event.Open)
        advanceUntilIdle()
        assertEquals(WsState.Connected, client.state.value)
    }

    @Test
    fun `disconnect stops the reconnect loop`() = runTest {
        val transport = FakeWsTransport()
        val conn = transport.nextConnection()
        val net = FakeNetworkMonitor().apply { emit(true) }
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val client = WsClientImpl(transport, net, scope)
        client.connect("https://pimote.example.com")
        conn.emit(WsTransport.Event.Open)
        advanceUntilIdle()

        client.disconnect()
        advanceUntilIdle()
        assertEquals(WsState.Disconnected, client.state.value)

        // Even with a long simulated delay no new attempts are scheduled.
        val opensBefore = transport.opens.size
        advanceTimeBy(60_000)
        advanceUntilIdle()
        assertEquals(opensBefore, transport.opens.size)
    }

    @Test
    fun `connect is idempotent for the same origin`() = runTest {
        val transport = FakeWsTransport()
        val conn = transport.nextConnection()
        val net = FakeNetworkMonitor().apply { emit(true) }
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val client = WsClientImpl(transport, net, scope)
        client.connect("https://pimote.example.com")
        client.connect("https://pimote.example.com")
        client.connect("https://pimote.example.com")
        conn.emit(WsTransport.Event.Open)
        advanceUntilIdle()
        assertEquals(1, transport.opens.size)
    }

    @Test
    fun `connect with a different origin reconfigures`() = runTest {
        val transport = FakeWsTransport()
        val first = transport.nextConnection()
        val second = transport.nextConnection()
        val net = FakeNetworkMonitor().apply { emit(true) }
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val client = WsClientImpl(transport, net, scope)

        client.connect("https://a.example.com")
        first.emit(WsTransport.Event.Open)
        advanceUntilIdle()
        client.connect("https://b.example.com")
        advanceUntilIdle()

        assertEquals(2, transport.opens.size)
        assertTrue(transport.opens[0].startsWith("https://a.example.com") || transport.opens[0].startsWith("wss://a.example.com") || transport.opens[0].contains("a.example.com"))
        assertTrue(transport.opens[1].contains("b.example.com"))
    }
}
