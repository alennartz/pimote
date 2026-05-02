package com.pimote.android.ui.components

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class StatusPillHelpersTest {
    @Test
    fun stripsLowercasePrefix() {
        assertEquals("connection refused", cleanStatusReason("ws error: connection refused"))
    }

    @Test
    fun stripsPrefixCaseInsensitive() {
        assertEquals("abc", cleanStatusReason("WS Error: abc"))
    }

    @Test
    fun truncatesLongStringWithEllipsis() {
        val input = "a".repeat(45)
        val out = cleanStatusReason(input)
        assertEquals("a".repeat(40) + "…", out)
    }

    @Test
    fun keepsExactlyFortyChars() {
        val input = "b".repeat(40)
        assertEquals(input, cleanStatusReason(input))
    }

    @Test
    fun stripsPrefixThenTruncates() {
        val payload = "c".repeat(50)
        val out = cleanStatusReason("ws error: $payload")
        assertEquals("c".repeat(40) + "…", out)
    }

    @Test
    fun emptyStringPassesThrough() {
        assertEquals("", cleanStatusReason(""))
    }
}
