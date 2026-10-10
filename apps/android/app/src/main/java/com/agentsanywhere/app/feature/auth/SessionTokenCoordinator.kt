package com.agentsanywhere.app.feature.auth

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.AuthResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

data class SessionTokens(
    val serverUrl: String,
    val accessToken: String,
    val refreshToken: String,
    val expiresAt: Long = 0,
    val generation: Long = 0,
)

/** Serializes refresh rotation while fencing responses from an earlier login. */
class SessionTokenCoordinator(
    initial: SessionTokens?,
    private val persist: (SessionTokens?) -> Unit,
    private val refresh: (SessionTokens) -> AuthResponse,
    private val updateIdentity: (AuthResponse) -> Unit,
    private val discardRefresh: (SessionTokens, AuthResponse) -> Unit = { _, _ -> },
) {
    private val stateLock = Any()
    private val refreshLock = Any()
    private var generation = 0L
    private var current = initial
    private val knownTokens = mutableSetOf<String>().apply { initial?.let { add(it.accessToken) } }
    private val changes = MutableStateFlow(0L)
    val revision = changes.asStateFlow()

    fun snapshot(): SessionTokens? = synchronized(stateLock) { current }

    fun match(serverUrl: String, token: String): SessionTokens? = synchronized(stateLock) {
        current?.takeIf { it.serverUrl == serverUrl && token in knownTokens }
    }

    fun replace(tokens: SessionTokens?, updateIdentity: () -> Unit = {}) = synchronized(stateLock) {
        generation++
        val replacement = tokens?.copy(generation = generation)
        persist(replacement)
        updateIdentity()
        current = replacement
        knownTokens.clear()
        replacement?.let { knownTokens.add(it.accessToken) }
        changes.value++
    }

    fun identityChanged() { synchronized(stateLock) { changes.value++ } }

    fun updateIfGeneration(expected: Long?, action: () -> Unit) = synchronized(stateLock) {
        if (current?.generation != expected || current == null) return@synchronized
        action()
        changes.value++
    }

    fun clearIfMatches(accessToken: String): Boolean = synchronized(stateLock) {
        if (current?.accessToken != accessToken || accessToken.isBlank()) return false
        replace(null)
        true
    }

    fun recover(expected: SessionTokens): String? = synchronized(refreshLock) {
        val active = synchronized(stateLock) {
            val latest = current ?: return null
            if (latest.generation != expected.generation) return null
            if (latest.accessToken != expected.accessToken) return latest.accessToken
            if (latest.refreshToken.isBlank()) return null
            latest
        }
        val response = try {
            refresh(active)
        } catch (error: ApiException) {
            // The caller reports a terminal 401. A transient network failure keeps the session.
            if (error.statusCode == 401 || error.statusCode == 403) return null
            throw error
        }
        val rotated = synchronized(stateLock) {
            if (current?.generation != active.generation) return@synchronized null
            val replacement = active.copy(
                accessToken = response.accessToken,
                refreshToken = requireNotNull(response.refreshToken) { "Refresh response has no refresh token." },
                expiresAt = System.currentTimeMillis() + response.expiresIn * 1000L,
            )
            persist(replacement)
            updateIdentity(response)
            current = replacement
            knownTokens.add(replacement.accessToken)
            changes.value++
            replacement.accessToken
        }
        if (rotated == null) runCatching { discardRefresh(active, response) }
        rotated
    }
}
