package com.pimote.android.call

import com.pimote.android.net.TypedResponse
import com.pimote.android.protocol.CallBindCommand
import com.pimote.android.protocol.CallBindErrorCodes
import com.pimote.android.protocol.CallBindResponseData
import com.pimote.android.protocol.CallEndCommand
import com.pimote.android.protocol.CallEndReasonWire
import com.pimote.android.protocol.CallEndedEvent
import com.pimote.android.protocol.CallReadyEvent
import com.pimote.android.protocol.OpenSessionCommand
import com.pimote.android.protocol.OpenSessionResponseData
import com.pimote.android.protocol.SessionClosedEvent
import com.pimote.android.protocol.SessionClosedReasonWire
import com.pimote.android.voice.PeerConnectionFailed
import com.pimote.android.voice.PeerState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Behavioral tests for [CallControllerImpl]. Drives the controller through
 * its outgoing-call flow with hand-rolled fakes for [WsClient],
 * [SpeechmuxPeer], and the Telecom [CallConnection]. Pure-JVM — no Android.
 *
 * The state machine, error branches, and event-filtering rules under test
 * are documented at length in
 * [CallController]'s KDoc and in docs/plans/native-android-client.md.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CallControllerTest {

    private fun newController(
        ws: FakeWsClient,
        peer: FakeSpeechmuxPeer,
        scope: CoroutineScope,
    ) = CallControllerImpl(
        wsClient = ws,
        peerFactory = { peer },
        scope = scope,
    )

    // -------------------------------------------------------------- happy paths

    @Test
    fun `existing-session call drives Idle to Active in order`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()

        // Bind request was issued.
        val bindCmd = ws.sent.single { it is CallBindCommand } as CallBindCommand
        assertEquals("S1", bindCmd.sessionId)
        assertEquals(false, bindCmd.force ?: false)

        ws.respondNext(
            TypedResponse(
                id = bindCmd.id,
                success = true,
                data = CallBindResponseData(sessionId = "S1", webrtcSignalUrl = "wss://m"),
                error = null,
            ),
        )
        advanceUntilIdle()

        // Peer was asked to connect with the URL from the bind response.
        assertEquals(listOf("wss://m" to "S1"), peer.connectCalls)
        // Now emit call_ready and verify Active.
        ws.emit(CallReadyEvent(sessionId = "S1"))
        advanceUntilIdle()

        assertTrue(cc.state.value is CallState.Active)
        assertEquals("S1", (cc.state.value as CallState.Active).sessionId)
        assertTrue(conn.transitions.contains("active"))
    }

    @Test
    fun `new-session-in-project opens session before binding`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.NewSessionInProject("/work/repo"), conn)
        advanceUntilIdle()

        val openCmd = ws.sent.first() as OpenSessionCommand
        assertEquals("/work/repo", openCmd.folderPath)

        ws.respondNext(
            TypedResponse(openCmd.id, success = true, data = OpenSessionResponseData("S2"), error = null),
        )
        advanceUntilIdle()

        val bindCmd = ws.sent.last { it is CallBindCommand } as CallBindCommand
        assertEquals("S2", bindCmd.sessionId)

        ws.respondNext(
            TypedResponse(bindCmd.id, success = true, data = CallBindResponseData("S2", "wss://m"), error = null),
        )
        advanceUntilIdle()

        ws.emit(CallReadyEvent(sessionId = "S2"))
        advanceUntilIdle()

        assertEquals(CallState.Active("S2"), cc.state.value)
    }

    // -------------------------------------------------------------- bind failures

    @Test
    fun `call_bind_failed_owned retries once with force=true`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()

        val first = ws.sent.last { it is CallBindCommand } as CallBindCommand
        assertEquals(false, first.force ?: false)
        ws.respondNext(
            TypedResponse<CallBindResponseData>(first.id, success = false, data = null, error = CallBindErrorCodes.OWNED),
        )
        advanceUntilIdle()

        val retry = ws.sent.last { it is CallBindCommand } as CallBindCommand
        assertEquals(true, retry.force)
        ws.respondNext(
            TypedResponse(retry.id, success = true, data = CallBindResponseData("S1", "wss://m"), error = null),
        )
        advanceUntilIdle()

        ws.emit(CallReadyEvent("S1"))
        advanceUntilIdle()
        assertTrue(cc.state.value is CallState.Active)
    }

    @Test
    fun `non-owned bind failure ends with BIND_FAILED and markFailed`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()
        val first = ws.sent.last { it is CallBindCommand } as CallBindCommand
        ws.respondNext(
            TypedResponse<CallBindResponseData>(first.id, success = false, data = null, error = CallBindErrorCodes.SESSION_NOT_FOUND),
        )
        advanceUntilIdle()

        val ended = cc.state.value
        assertTrue(ended is CallState.Ended)
        assertEquals(CallEndReason.BIND_FAILED, (ended as CallState.Ended).reason)
        assertTrue(conn.transitions.any { it.startsWith("failed:") })
    }

    @Test
    fun `open_session failure ends with BIND_FAILED and null sessionId`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.NewSessionInProject("/p"), conn)
        advanceUntilIdle()
        val open = ws.sent.first() as OpenSessionCommand
        ws.respondNext(
            TypedResponse<OpenSessionResponseData>(open.id, success = false, data = null, error = "open_session_failed"),
        )
        advanceUntilIdle()

        val ended = cc.state.value as CallState.Ended
        assertEquals(null, ended.sessionId)
        assertEquals(CallEndReason.BIND_FAILED, ended.reason)
        // No call_bind ever issued.
        assertTrue(ws.sent.none { it is CallBindCommand })
    }

    // -------------------------------------------------------------- in-call failures

    @Test
    fun `peer connect failure ends with PEER_FAILED and best-effort call_end`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer().apply { connectFailure = PeerConnectionFailed("ice timeout") }
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()
        val bind = ws.sent.last { it is CallBindCommand } as CallBindCommand
        ws.respondNext(
            TypedResponse(bind.id, success = true, data = CallBindResponseData("S1", "wss://m"), error = null),
        )
        advanceUntilIdle()

        val ended = cc.state.value as CallState.Ended
        assertEquals(CallEndReason.PEER_FAILED, ended.reason)
        assertEquals("S1", ended.sessionId)
        assertTrue(conn.transitions.any { it.startsWith("failed:") })
        assertTrue(ws.sent.any { it is CallEndCommand })
    }

    @Test
    fun `server call_ended while Active triggers markEndedRemotely and peer disconnect`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()
        val bind = ws.sent.last { it is CallBindCommand } as CallBindCommand
        ws.respondNext(
            TypedResponse(bind.id, success = true, data = CallBindResponseData("S1", "wss://m"), error = null),
        )
        advanceUntilIdle()
        ws.emit(CallReadyEvent("S1"))
        advanceUntilIdle()
        assertTrue(cc.state.value is CallState.Active)

        ws.emit(CallEndedEvent("S1", reason = CallEndReasonWire.SERVER_ENDED))
        advanceUntilIdle()

        val ended = cc.state.value as CallState.Ended
        assertEquals(CallEndReason.SERVER_ENDED, ended.reason)
        assertTrue(peer.disconnected)
        assertTrue(conn.transitions.any { it.startsWith("endedRemotely:") })
    }

    @Test
    fun `peer state transitions to Failed during Active triggers PEER_FAILED`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()
        val bind = ws.sent.last { it is CallBindCommand } as CallBindCommand
        ws.respondNext(
            TypedResponse(bind.id, success = true, data = CallBindResponseData("S1", "wss://m"), error = null),
        )
        advanceUntilIdle()
        ws.emit(CallReadyEvent("S1"))
        advanceUntilIdle()

        // Now the peer fails mid-call.
        peer.state.value = PeerState.Failed("ice disconnected")
        advanceUntilIdle()

        val ended = cc.state.value as CallState.Ended
        assertEquals(CallEndReason.PEER_FAILED, ended.reason)
        assertTrue(ws.sent.any { it is CallEndCommand })
    }

    @Test
    fun `endCurrentCall sends CallEnd best-effort and ends with USER_HANGUP`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()
        val bind = ws.sent.last { it is CallBindCommand } as CallBindCommand
        ws.respondNext(
            TypedResponse(bind.id, success = true, data = CallBindResponseData("S1", "wss://m"), error = null),
        )
        advanceUntilIdle()
        ws.emit(CallReadyEvent("S1"))
        advanceUntilIdle()
        assertTrue(cc.state.value is CallState.Active)

        cc.endCurrentCall()
        advanceUntilIdle()

        val ended = cc.state.value as CallState.Ended
        assertEquals(CallEndReason.USER_HANGUP, ended.reason)
        assertTrue(peer.disconnected)
        assertTrue(ws.sent.any { it is CallEndCommand })
        // Critical: the Telecom connection must be torn down on user hangup so
        // the system leaves MODE_IN_COMMUNICATION and releases the mic. Without
        // this, other apps see the mic as "already in use."
        assertTrue(
            conn.transitions.contains("endedLocally"),
            "expected endedLocally; got transitions=${conn.transitions}",
        )
    }

    // -------------------------------------------------------------- event filtering

    @Test
    fun `events for a different sessionId are ignored while Active`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()
        val bind = ws.sent.last { it is CallBindCommand } as CallBindCommand
        ws.respondNext(
            TypedResponse(bind.id, success = true, data = CallBindResponseData("S1", "wss://m"), error = null),
        )
        advanceUntilIdle()
        ws.emit(CallReadyEvent("S1"))
        advanceUntilIdle()

        // call_ended for a stranger session — must be ignored.
        ws.emit(CallEndedEvent("OTHER", reason = CallEndReasonWire.SERVER_ENDED))
        advanceUntilIdle()

        assertTrue(cc.state.value is CallState.Active)
        assertFalse(peer.disconnected)
    }

    @Test
    fun `call_bind_failed_owned retry that also fails ends with BIND_FAILED`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()
        val first = ws.sent.last { it is CallBindCommand } as CallBindCommand
        ws.respondNext(
            TypedResponse<CallBindResponseData>(first.id, success = false, data = null, error = CallBindErrorCodes.OWNED),
        )
        advanceUntilIdle()
        val retry = ws.sent.last { it is CallBindCommand } as CallBindCommand
        assertEquals(true, retry.force)
        ws.respondNext(
            TypedResponse<CallBindResponseData>(retry.id, success = false, data = null, error = CallBindErrorCodes.OWNED),
        )
        advanceUntilIdle()

        // No third bind — the retry is single-shot.
        assertEquals(2, ws.sent.count { it is CallBindCommand })
        val ended = cc.state.value as CallState.Ended
        assertEquals(CallEndReason.BIND_FAILED, ended.reason)
        assertEquals("S1", ended.sessionId)
        assertTrue(conn.transitions.any { it.startsWith("failed:") })
    }

    @Test
    fun `server call_ended maps wire user_hangup to USER_HANGUP`() = runTest {
        assertWireReasonMaps(CallEndReasonWire.USER_HANGUP, CallEndReason.USER_HANGUP, testScheduler)
    }

    @Test
    fun `server call_ended maps wire displaced to DISPLACED`() = runTest {
        assertWireReasonMaps(CallEndReasonWire.DISPLACED, CallEndReason.DISPLACED, testScheduler)
    }

    private suspend fun kotlinx.coroutines.test.TestScope.assertWireReasonMaps(
        wire: CallEndReasonWire,
        expected: CallEndReason,
        scheduler: kotlinx.coroutines.test.TestCoroutineScheduler,
    ) {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(scheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()
        val bind = ws.sent.last { it is CallBindCommand } as CallBindCommand
        ws.respondNext(
            TypedResponse(bind.id, success = true, data = CallBindResponseData("S1", "wss://m"), error = null),
        )
        advanceUntilIdle()
        ws.emit(CallReadyEvent("S1"))
        advanceUntilIdle()

        ws.emit(CallEndedEvent("S1", reason = wire))
        advanceUntilIdle()

        val ended = cc.state.value as CallState.Ended
        assertEquals(expected, ended.reason)
    }

    // ---------------------------------------------- displacement (session_closed)

    @Test
    fun `session_closed displaced for active session ends call with DISPLACED`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()
        val bind = ws.sent.last { it is CallBindCommand } as CallBindCommand
        ws.respondNext(
            TypedResponse(bind.id, success = true, data = CallBindResponseData("S1", "wss://m"), error = null),
        )
        advanceUntilIdle()
        ws.emit(CallReadyEvent("S1"))
        advanceUntilIdle()
        assertTrue(cc.state.value is CallState.Active)

        ws.emit(SessionClosedEvent(sessionId = "S1", reason = SessionClosedReasonWire.DISPLACED))
        advanceUntilIdle()

        val ended = cc.state.value as CallState.Ended
        assertEquals("S1", ended.sessionId)
        assertEquals(CallEndReason.DISPLACED, ended.reason)
        assertTrue(peer.disconnected)
        assertTrue(conn.transitions.contains("endedRemotely:DISPLACED"))
    }

    @Test
    fun `session_closed displaced for a different session is ignored`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()
        val bind = ws.sent.last { it is CallBindCommand } as CallBindCommand
        ws.respondNext(
            TypedResponse(bind.id, success = true, data = CallBindResponseData("S1", "wss://m"), error = null),
        )
        advanceUntilIdle()
        ws.emit(CallReadyEvent("S1"))
        advanceUntilIdle()
        assertTrue(cc.state.value is CallState.Active)

        ws.emit(SessionClosedEvent(sessionId = "OTHER", reason = SessionClosedReasonWire.DISPLACED))
        advanceUntilIdle()

        // Still active — the event was for a different session.
        assertTrue(cc.state.value is CallState.Active)
        assertEquals(false, peer.disconnected)
    }

    @Test
    fun `session_closed with non-displaced reasons are ignored`() = runTest {
        // PWA only synthesizes call_ended for `displaced`. We mirror that:
        // KILLED / REPLACED / null reason should NOT end the call. The
        // peer will fail organically if the underlying agent session
        // really is gone.
        val cases = listOf(
            SessionClosedReasonWire.KILLED,
            SessionClosedReasonWire.REPLACED,
            null,
        )
        for (reason in cases) {
            val ws = FakeWsClient()
            val peer = FakeSpeechmuxPeer()
            val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
            val conn = FakeCallConnection()

            cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
            advanceUntilIdle()
            val bind = ws.sent.last { it is CallBindCommand } as CallBindCommand
            ws.respondNext(
                TypedResponse(bind.id, success = true, data = CallBindResponseData("S1", "wss://m"), error = null),
            )
            advanceUntilIdle()
            ws.emit(CallReadyEvent("S1"))
            advanceUntilIdle()

            ws.emit(SessionClosedEvent(sessionId = "S1", reason = reason))
            advanceUntilIdle()

            assertTrue(
                cc.state.value is CallState.Active,
                "reason=$reason should not end the call (state=${cc.state.value})",
            )
        }
    }

    @Test
    fun `setAudioRoute forwards to the active connection`() = runTest {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher(testScheduler)))
        val conn = FakeCallConnection()

        // Before any call: setAudioRoute is a no-op (no connection bound).
        cc.setAudioRoute(AudioRoute.SPEAKER)
        assertTrue(conn.routeRequests.isEmpty())

        cc.startOutgoing(SessionTarget.ExistingSession("S1"), conn)
        advanceUntilIdle()

        cc.setAudioRoute(AudioRoute.SPEAKER)
        cc.setAudioRoute(AudioRoute.EARPIECE)
        assertEquals(listOf(AudioRoute.SPEAKER, AudioRoute.EARPIECE), conn.routeRequests)
    }

    @Test
    fun `onAudioStateChanged updates audioRoute snapshot`() {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val cc = newController(ws, peer, TestScope(StandardTestDispatcher()))

        assertEquals(null, cc.audioRoute.value)
        val snap = AudioRouteSnapshot(
            isMuted = false,
            route = AudioRoute.SPEAKER,
            supportedRoutes = setOf(AudioRoute.EARPIECE, AudioRoute.SPEAKER),
        )
        cc.onAudioStateChanged(snap)
        assertEquals(snap, cc.audioRoute.value)
    }

    @Test
    fun `state starts at Idle`() {
        val ws = FakeWsClient()
        val peer = FakeSpeechmuxPeer()
        val scope = TestScope(StandardTestDispatcher())
        val cc = newController(ws, peer, scope)
        assertEquals(CallState.Idle, cc.state.value)
    }
}
