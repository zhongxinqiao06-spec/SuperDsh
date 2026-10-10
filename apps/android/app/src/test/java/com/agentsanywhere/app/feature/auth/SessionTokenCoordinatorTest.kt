package com.agentsanywhere.app.feature.auth

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.AuthResponse
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class SessionTokenCoordinatorTest {
    private val initial = SessionTokens("https://example.test", "old-access", "old-refresh")
    private fun response() = AuthResponse("user", "member", "new-access", "bearer", "now", refreshToken = "new-refresh")

    @Test fun concurrentUnauthorizedRequestsRotateOnlyOnce() {
        val calls = AtomicInteger()
        val entered = CountDownLatch(1)
        val finish = CountDownLatch(1)
        val coordinator = SessionTokenCoordinator(initial, {}, {
            calls.incrementAndGet(); entered.countDown()
            check(finish.await(3, TimeUnit.SECONDS)); response()
        }, {})
        val pool = Executors.newFixedThreadPool(6)
        try {
            val futures = (1..6).map { pool.submit<String?> { coordinator.recover(initial) } }
            assertTrue(entered.await(3, TimeUnit.SECONDS))
            finish.countDown()
            assertEquals(List(6) { "new-access" }, futures.map { it.get(3, TimeUnit.SECONDS) })
            assertEquals(1, calls.get())
            assertEquals("new-refresh", coordinator.snapshot()?.refreshToken)
        } finally { pool.shutdownNow() }
    }

    @Test fun oldRefreshCannotOverwriteNewLoginAndItsCredentialIsRevoked() {
        val entered = CountDownLatch(1)
        val finish = CountDownLatch(1)
        var discarded: String? = null
        val coordinator = SessionTokenCoordinator(initial, {}, {
            entered.countDown(); check(finish.await(3, TimeUnit.SECONDS)); response()
        }, {}, { _, result -> discarded = result.refreshToken })
        val pool = Executors.newSingleThreadExecutor()
        try {
            val request = pool.submit<String?> { coordinator.recover(initial) }
            assertTrue(entered.await(3, TimeUnit.SECONDS))
            coordinator.replace(initial.copy(accessToken = "another-user", refreshToken = "another-refresh"))
            finish.countDown()
            assertNull(request.get(3, TimeUnit.SECONDS))
            assertEquals("another-user", coordinator.snapshot()?.accessToken)
            assertEquals("new-refresh", discarded)
            assertFalse(coordinator.clearIfMatches("old-access"))
        } finally { pool.shutdownNow() }
    }

    @Test fun logoutFencesThePreviousIdentityAndTokens() {
        val coordinator = SessionTokenCoordinator(initial, {}, { response() }, {})
        coordinator.replace(null)
        assertNull(coordinator.recover(initial))
        assertNull(coordinator.snapshot())
        var updated = false
        coordinator.updateIfGeneration(initial.generation) { updated = true }
        assertFalse(updated)
    }

    @Test fun transientFailureRetainsTheSession() {
        val coordinator = SessionTokenCoordinator(initial, {}, { throw ApiException("offline") }, {})
        try { coordinator.recover(initial); fail("Expected network failure") } catch (_: ApiException) { }
        assertEquals(initial, coordinator.snapshot())
    }

    @Test fun refusedRefreshDoesNotRetryOrExposeAnotherLogin() {
        val coordinator = SessionTokenCoordinator(initial, {}, { throw ApiException("expired", 401) }, {})
        assertNull(coordinator.recover(initial))
        assertTrue(coordinator.clearIfMatches("old-access"))
        coordinator.replace(initial.copy(accessToken = "new-login"))
        assertNull(coordinator.match("https://other.test", "new-login"))
        assertNull(coordinator.match(initial.serverUrl, "old-access"))
    }

    @Test fun lateUnauthorizedUsesTheAlreadyRotatedToken() {
        val calls = AtomicInteger()
        val coordinator = SessionTokenCoordinator(initial, {}, { calls.incrementAndGet(); response() }, {})
        assertEquals("new-access", coordinator.recover(initial))
        assertEquals("new-access", coordinator.recover(initial))
        assertEquals("new-access", coordinator.match(initial.serverUrl, "old-access")?.accessToken)
        assertEquals(1, calls.get())
    }
}
