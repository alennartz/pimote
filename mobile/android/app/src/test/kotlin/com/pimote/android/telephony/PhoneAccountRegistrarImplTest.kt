package com.pimote.android.telephony

import com.pimote.android.session.ProjectMeta
import com.pimote.android.session.SessionMeta
import com.pimote.android.session.SessionRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Behavioral tests for [PhoneAccountRegistrarImpl]: the live wiring around
 * [PhoneAccountRules] \u2014 debounce, diff, apply via [TelecomFacade], and the
 * `handleId \u2192 AccountKind` resolve map.
 *
 * Pure-rule behavior (sanitization, disambiguation, diff math) is covered in
 * [PhoneAccountRulesTest]. These tests exercise the orchestration only.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PhoneAccountRegistrarImplTest {

    private class FakeRepo : SessionRepository {
        override val projects = MutableStateFlow<List<ProjectMeta>>(emptyList())
        override val sessions = MutableStateFlow<List<SessionMeta>>(emptyList())
        override fun start() {}
        override fun stop() {}
        override suspend fun refresh() {}
    }

    private class FakeTelecom : TelecomFacade {
        val accounts = mutableMapOf<String, TelecomFacade.Account>()
        val opLog = mutableListOf<String>()
        override fun registeredAccounts() = accounts.toMap()
        override fun registerPhoneAccount(account: TelecomFacade.Account) {
            opLog.add("register:${account.handleId}=${account.label}")
            accounts[account.handleId] = account
        }
        override fun unregisterPhoneAccount(handleId: String) {
            opLog.add("unregister:$handleId")
            accounts.remove(handleId)
        }
    }

    @Test
    fun `bursty updates within debounce window collapse to a single reconcile`() = runTest {
        val repo = FakeRepo()
        val tel = FakeTelecom()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val r = PhoneAccountRegistrarImpl(repo, tel, scope, debounceMs = 500L)
        r.start()

        // Burst of three updates within < 500 ms.
        repo.projects.value = listOf(ProjectMeta("/p", "p"))
        advanceTimeBy(100)
        repo.sessions.value = listOf(SessionMeta("s1", "/p", "p", "feat", archived = false))
        advanceTimeBy(100)
        repo.sessions.value = listOf(
            SessionMeta("s1", "/p", "p", "feat", archived = false),
            SessionMeta("s2", "/p", "p", "next", archived = false),
        )

        // Debounce hasn't elapsed yet \u2014 no telecom calls.
        assertEquals(0, tel.opLog.size)

        advanceTimeBy(600)
        advanceUntilIdle()

        // After debounce, one reconcile pass registered 1 project + 2 sessions.
        val regs = tel.opLog.count { it.startsWith("register:") }
        assertEquals(3, regs)
    }

    @Test
    fun `diff drives register, unregister, and replace operations`() = runTest {
        val repo = FakeRepo()
        val tel = FakeTelecom()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val r = PhoneAccountRegistrarImpl(repo, tel, scope, debounceMs = 50L)
        r.start()

        repo.projects.value = listOf(ProjectMeta("/p", "p"))
        repo.sessions.value = listOf(SessionMeta("s1", "/p", "p", "old", archived = false))
        advanceTimeBy(100); advanceUntilIdle()
        val afterFirst = tel.opLog.toList()
        assertTrue(afterFirst.any { it.contains("register:session:s1") && it.contains("p/old") })

        // Now: rename s1 (label change) and add s2.
        repo.sessions.value = listOf(
            SessionMeta("s1", "/p", "p", "new", archived = false),
            SessionMeta("s2", "/p", "p", "fresh", archived = false),
        )
        advanceTimeBy(100); advanceUntilIdle()

        val afterSecond = tel.opLog.drop(afterFirst.size)
        // s1 label changed \u2192 unregister + reregister; s2 added.
        assertTrue(afterSecond.any { it == "unregister:session:s1" })
        assertTrue(afterSecond.any { it.contains("register:session:s1") && it.contains("p/new") })
        assertTrue(afterSecond.any { it.contains("register:session:s2") })
    }

    @Test
    fun `removed sessions are unregistered`() = runTest {
        val repo = FakeRepo()
        val tel = FakeTelecom()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val r = PhoneAccountRegistrarImpl(repo, tel, scope, debounceMs = 50L)
        r.start()

        repo.projects.value = listOf(ProjectMeta("/p", "p"))
        repo.sessions.value = listOf(SessionMeta("s1", "/p", "p", "n", archived = false))
        advanceTimeBy(100); advanceUntilIdle()

        repo.sessions.value = emptyList()
        advanceTimeBy(100); advanceUntilIdle()

        assertTrue(tel.opLog.contains("unregister:session:s1"))
        assertFalse(tel.accounts.containsKey("session:s1"))
    }

    @Test
    fun `resolve returns AccountKind for registered handle and null otherwise`() = runTest {
        val repo = FakeRepo()
        val tel = FakeTelecom()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val r = PhoneAccountRegistrarImpl(repo, tel, scope, debounceMs = 50L)
        r.start()

        repo.projects.value = listOf(ProjectMeta("/work/repo", "repo"))
        repo.sessions.value = listOf(SessionMeta("s1", "/work/repo", "repo", "feat", archived = false))
        advanceTimeBy(100); advanceUntilIdle()

        val sessionHandle = PhoneAccountRules.sessionHandleId("s1")
        val projectHandle = PhoneAccountRules.projectHandleId("/work/repo")
        val sessionKind = r.resolve(sessionHandle)
        val projectKind = r.resolve(projectHandle)

        assertNotNull(sessionKind)
        assertNotNull(projectKind)
        assertTrue(sessionKind is AccountKind.Session)
        assertEquals("s1", (sessionKind as AccountKind.Session).sessionId)
        assertTrue(projectKind is AccountKind.Project)
        assertEquals("/work/repo", (projectKind as AccountKind.Project).folderPath)
        assertNull(r.resolve("session:not-registered"))
    }

    @Test
    fun `stop best-effort unregisters everything`() = runTest {
        val repo = FakeRepo()
        val tel = FakeTelecom()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val r = PhoneAccountRegistrarImpl(repo, tel, scope, debounceMs = 50L)
        r.start()
        repo.projects.value = listOf(ProjectMeta("/p", "p"))
        repo.sessions.value = listOf(SessionMeta("s1", "/p", "p", "n", archived = false))
        advanceTimeBy(100); advanceUntilIdle()
        assertTrue(tel.accounts.isNotEmpty())

        r.stop()
        advanceUntilIdle()

        assertTrue(tel.accounts.isEmpty(), "expected empty after stop, was ${tel.accounts.keys}")
    }

}
