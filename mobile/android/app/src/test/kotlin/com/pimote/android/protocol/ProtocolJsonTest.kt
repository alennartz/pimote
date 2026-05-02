package com.pimote.android.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Wire-format tests for the hand-written Kotlin DTOs in [Protocol]. Validates
 * encoding for commands, decoding for responses, and the polymorphic event
 * dispatcher keyed off the `type` discriminator.
 */
class ProtocolJsonTest {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        classDiscriminator = "_classDiscriminatorUnusedHere"
    }

    // ----- Commands → JSON ---------------------------------------------------

    @Test
    fun `OpenSessionCommand encodes type and required folderPath`() {
        val cmd = OpenSessionCommand(id = "cmd-1", folderPath = "/work/repo")
        val tree = json.encodeToJsonElement(OpenSessionCommand.serializer(), cmd).jsonObject
        assertEquals("open_session", tree["type"]!!.jsonPrimitive.content)
        assertEquals("cmd-1", tree["id"]!!.jsonPrimitive.content)
        assertEquals("/work/repo", tree["folderPath"]!!.jsonPrimitive.content)
    }

    @Test
    fun `ListSessionsCommand encodes includeArchived when set`() {
        val cmd = ListSessionsCommand(id = "x", folderPath = "/p", includeArchived = false)
        val tree = json.encodeToJsonElement(ListSessionsCommand.serializer(), cmd).jsonObject
        assertEquals("list_sessions", tree["type"]!!.jsonPrimitive.content)
        assertEquals(false, tree["includeArchived"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `CallBindCommand encodes force flag`() {
        val cmd = CallBindCommand(id = "id1", sessionId = "s1", force = true)
        val tree = json.encodeToJsonElement(CallBindCommand.serializer(), cmd).jsonObject
        assertEquals("call_bind", tree["type"]!!.jsonPrimitive.content)
        assertEquals("s1", tree["sessionId"]!!.jsonPrimitive.content)
        assertEquals(true, tree["force"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `CallEndCommand encodes the type discriminator`() {
        val cmd = CallEndCommand(id = "id1", sessionId = "s1")
        val tree = json.encodeToJsonElement(CallEndCommand.serializer(), cmd).jsonObject
        assertEquals("call_end", tree["type"]!!.jsonPrimitive.content)
    }

    // ----- Response payloads -------------------------------------------------

    @Test
    fun `PimoteResponse decodes success with data slot`() {
        val raw = """{"id":"a","success":true,"data":{"sessionId":"S","webrtcSignalUrl":"wss://x"}}"""
        val resp = json.decodeFromString(PimoteResponse.serializer(), raw)
        assertEquals("a", resp.id)
        assertTrue(resp.success)
        assertNotNull(resp.data)
        val data = json.decodeFromJsonElement(CallBindResponseData.serializer(), resp.data!!)
        assertEquals("S", data.sessionId)
        assertEquals("wss://x", data.webrtcSignalUrl)
    }

    @Test
    fun `PimoteResponse decodes failure with error code`() {
        val raw = """{"id":"a","success":false,"error":"call_bind_failed_owned"}"""
        val resp = json.decodeFromString(PimoteResponse.serializer(), raw)
        assertEquals(false, resp.success)
        assertEquals(CallBindErrorCodes.OWNED, resp.error)
    }

    @Test
    fun `OpenSessionResponseData decodes minimal payload`() {
        val raw = """{"sessionId":"S1"}"""
        val data = json.decodeFromString(OpenSessionResponseData.serializer(), raw)
        assertEquals("S1", data.sessionId)
    }

    // ----- Polymorphic events ------------------------------------------------

    @Test
    fun `decodes session_opened event by discriminator`() {
        val raw = """{"type":"session_opened","sessionId":"S","folder":{"path":"/p","name":"p"}}"""
        val ev = json.decodeFromString(PimoteEventSerializer, raw)
        assertTrue(ev is SessionOpenedEvent)
        ev as SessionOpenedEvent
        assertEquals("S", ev.sessionId)
        assertEquals("/p", ev.folder.path)
        assertEquals("p", ev.folder.name)
    }

    @Test
    fun `decodes call_ready event`() {
        val raw = """{"type":"call_ready","sessionId":"S"}"""
        val ev = json.decodeFromString(PimoteEventSerializer, raw)
        assertTrue(ev is CallReadyEvent)
        assertEquals("S", (ev as CallReadyEvent).sessionId)
    }

    @Test
    fun `decodes call_ended with reason enum`() {
        val raw = """{"type":"call_ended","sessionId":"S","reason":"user_hangup"}"""
        val ev = json.decodeFromString(PimoteEventSerializer, raw)
        assertTrue(ev is CallEndedEvent)
        assertEquals(CallEndReasonWire.USER_HANGUP, (ev as CallEndedEvent).reason)
    }

    @Test
    fun `decodes call_ended with displaced reason`() {
        val raw = """{"type":"call_ended","sessionId":"S","reason":"displaced"}"""
        val ev = json.decodeFromString(PimoteEventSerializer, raw) as CallEndedEvent
        assertEquals(CallEndReasonWire.DISPLACED, ev.reason)
    }

    @Test
    fun `decodes call_status with all four statuses`() {
        listOf("binding", "ringing", "connected", "ended").forEach { s ->
            val raw = """{"type":"call_status","sessionId":"S","status":"$s"}"""
            val ev = json.decodeFromString(PimoteEventSerializer, raw)
            assertTrue(ev is CallStatusEvent)
        }
    }

    @Test
    fun `decodes session_replaced with old and new ids`() {
        val raw = """{"type":"session_replaced","oldSessionId":"O","newSessionId":"N",
                      "folder":{"path":"/p","name":"p"}}"""
        val ev = json.decodeFromString(PimoteEventSerializer, raw)
        assertTrue(ev is SessionReplacedEvent)
        ev as SessionReplacedEvent
        assertEquals("O", ev.oldSessionId)
        assertEquals("N", ev.newSessionId)
    }

    @Test
    fun `decodes session_closed with each reason and with reason omitted`() {
        // Each named reason round-trips into the typed enum.
        listOf("displaced" to SessionClosedReasonWire.DISPLACED,
               "killed" to SessionClosedReasonWire.KILLED,
               "replaced" to SessionClosedReasonWire.REPLACED).forEach { (wire, parsed) ->
            val raw = """{"type":"session_closed","sessionId":"S","reason":"$wire"}"""
            val ev = json.decodeFromString(PimoteEventSerializer, raw)
            assertTrue(ev is SessionClosedEvent)
            ev as SessionClosedEvent
            assertEquals("S", ev.sessionId)
            assertEquals(parsed, ev.reason)
        }
        // Reason is optional — older / non-displacement closes may omit it.
        val noReason = json.decodeFromString(
            PimoteEventSerializer,
            """{"type":"session_closed","sessionId":"S"}""",
        )
        assertTrue(noReason is SessionClosedEvent)
        assertEquals(null, (noReason as SessionClosedEvent).reason)
    }

    @Test
    fun `decodes session_renamed and session_archived and session_deleted`() {
        val a = json.decodeFromString(
            PimoteEventSerializer,
            """{"type":"session_renamed","sessionId":"S","folderPath":"/p","name":"hi"}""",
        )
        assertTrue(a is SessionRenamedEvent)

        val b = json.decodeFromString(
            PimoteEventSerializer,
            """{"type":"session_archived","sessionId":"S","folderPath":"/p","archived":true}""",
        )
        assertTrue(b is SessionArchivedEvent)
        assertEquals(true, (b as SessionArchivedEvent).archived)

        val c = json.decodeFromString(
            PimoteEventSerializer,
            """{"type":"session_deleted","sessionId":"S","folderPath":"/p"}""",
        )
        assertTrue(c is SessionDeletedEvent)
    }

    @Test
    fun `decodes call_bind_response event`() {
        val raw = """{"type":"call_bind_response","id":"i","sessionId":"S","webrtcSignalUrl":"wss://x"}"""
        val ev = json.decodeFromString(PimoteEventSerializer, raw)
        assertTrue(ev is CallBindResponseEvent)
        ev as CallBindResponseEvent
        assertEquals("wss://x", ev.webrtcSignalUrl)
    }

    @Test
    fun `unknown event type throws UnknownPimoteEventTypeException`() {
        val raw = """{"type":"not_a_real_event","x":1}"""
        val ex = assertThrows(UnknownPimoteEventTypeException::class.java) {
            json.decodeFromString(PimoteEventSerializer, raw)
        }
        assertEquals("not_a_real_event", ex.eventType)
    }

    @Test
    fun `missing type discriminator throws`() {
        val raw = """{"sessionId":"S"}"""
        assertThrows(IllegalArgumentException::class.java) {
            json.decodeFromString(PimoteEventSerializer, raw)
        }
    }

    @Test
    fun `CallBindErrorCodes constants match wire strings`() {
        // These literal strings are part of the protocol surface — pin them.
        assertEquals("call_bind_failed_session_not_found", CallBindErrorCodes.SESSION_NOT_FOUND)
        assertEquals("call_bind_failed_owned", CallBindErrorCodes.OWNED)
        assertEquals("call_bind_failed_internal", CallBindErrorCodes.INTERNAL)
    }
}
