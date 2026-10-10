package com.agentsanywhere.app.feature.auth

import android.content.Context
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.AuthMeResponse
import com.agentsanywhere.app.api.AuthResponse
import com.agentsanywhere.app.api.MobileLoginExchangeResponse
import com.agentsanywhere.app.api.normalizeServerOrigin
import org.json.JSONObject

class AuthSessionStore(context: Context) : AuthSessionReader {
    private val preferences = context.applicationContext.getSharedPreferences("agents_anywhere_auth", Context.MODE_PRIVATE)
    private val securePreferences = context.applicationContext.getSharedPreferences("superdsh_auth_secure", Context.MODE_PRIVATE)
    private val cipher = TokenCipher()
    val tokens: SessionTokenCoordinator = synchronized(INIT_LOCK) {
        sharedTokens ?: SessionTokenCoordinator(
            initial = loadAndMigrate(),
            persist = ::persistTokens,
            refresh = { AuthApi().refresh(it.serverUrl, it.refreshToken) },
            updateIdentity = ::saveIdentity,
            discardRefresh = { previous, response -> response.refreshToken?.let { AuthApi().logout(previous.serverUrl, it) } },
        ).also { sharedTokens = it }
    }

    override fun readServerUrl(): String = normalizeServerOrigin(preferences.getString("server_url", "").orEmpty()).orEmpty()
    override fun readAccessToken(): String = tokens.snapshot()?.accessToken.orEmpty()
    fun readUserId(): String = preferences.getString("user_id", "").orEmpty()
    fun readRole(): String = preferences.getStringSet("roles", emptySet()).orEmpty().joinToString(", ")
        .ifBlank { preferences.getString("role", "").orEmpty() }
    override fun readPermissions(): Set<String> = preferences.getStringSet("permissions", emptySet()).orEmpty().toSet()
    fun resetRequired(): Boolean = preferences.getBoolean("reset_required", false)
    fun hasAuthSession(): Boolean = readServerUrl().isNotBlank() && readAccessToken().isNotBlank()

    fun saveServerUrl(serverUrl: String) {
        val origin = requireNotNull(normalizeServerOrigin(serverUrl))
        if (tokens.snapshot()?.serverUrl?.let { it != origin } == true) clearAuthSession()
        preferences.edit().putString("server_url", origin).apply()
    }

    fun saveAuthSession(serverUrl: String, auth: AuthResponse) {
        val origin = requireNotNull(normalizeServerOrigin(serverUrl))
        tokens.replace(SessionTokens(origin, auth.accessToken, auth.refreshToken.orEmpty(),
            System.currentTimeMillis() + auth.expiresIn * 1000L)) {
            preferences.edit().putString("server_url", origin).commit()
            saveIdentity(auth)
        }
    }

    fun saveMobileAuthSession(serverUrl: String, exchange: MobileLoginExchangeResponse) {
        saveAuthSession(serverUrl, exchange.auth.copy(refreshToken = exchange.refreshToken))
    }

    fun saveMe(me: AuthMeResponse, expectedGeneration: Long?) {
        tokens.updateIfGeneration(expectedGeneration) {
        preferences.edit().putString("user_id", me.userId).putString("role", me.role)
            .putStringSet("roles", me.roles.toSet()).putStringSet("permissions", me.permissions)
            .putLong("authz_version", me.authzVersion).putBoolean("reset_required", me.resetRequired).apply()
        }
    }

    private fun saveIdentity(auth: AuthResponse) {
        preferences.edit().putString("user_id", auth.userId).putString("role", auth.role)
            .putStringSet("roles", auth.roles.toSet()).putStringSet("permissions", auth.permissions)
            .putLong("authz_version", auth.authzVersion).putBoolean("reset_required", auth.resetRequired).apply()
    }

    fun clearAuthSession() { tokens.replace(null) }
    fun clearAuthSessionIfTokenMatches(accessToken: String): Boolean = tokens.clearIfMatches(accessToken)

    private fun persistTokens(value: SessionTokens?) {
        val editor = securePreferences.edit()
        if (value == null) editor.remove("credentials") else editor.putString("credentials", cipher.encrypt(
            JSONObject().put("serverUrl", value.serverUrl).put("accessToken", value.accessToken)
                .put("refreshToken", value.refreshToken).put("expiresAt", value.expiresAt).toString(),
        ))
        check(editor.commit()) { "Could not save secure session." }
        preferences.edit().remove("access_token").remove("refresh_token")
            .remove("refresh_expires_at").remove("token_type").commit()
    }

    private fun loadAndMigrate(): SessionTokens? {
        val encrypted = securePreferences.getString("credentials", null)
        if (encrypted != null) {
            return runCatching {
                val json = JSONObject(cipher.decrypt(encrypted))
                SessionTokens(json.getString("serverUrl"), json.getString("accessToken"),
                    json.optString("refreshToken"), json.optLong("expiresAt"))
            }.getOrElse {
                // A restored backup cannot decrypt another device's Keystore key. Require sign-in.
                securePreferences.edit().remove("credentials").commit()
                preferences.edit().remove("access_token").remove("refresh_token").commit()
                null
            }
        }
        val access = preferences.getString("access_token", "").orEmpty()
        if (access.isBlank() || readServerUrl().isBlank()) return null
        val migrated = SessionTokens(readServerUrl(), access, preferences.getString("refresh_token", "").orEmpty())
        return runCatching { persistTokens(migrated); migrated }.getOrElse {
            preferences.edit().remove("access_token").remove("refresh_token").commit()
            null
        }
    }

    private companion object {
        val INIT_LOCK = Any()
        var sharedTokens: SessionTokenCoordinator? = null
    }
}

interface AuthSessionReader {
    fun readServerUrl(): String
    fun readAccessToken(): String
    fun readPermissions(): Set<String> = emptySet()
}

internal fun shouldClearAuthSession(currentAccessToken: String, unauthorizedAccessToken: String): Boolean =
    unauthorizedAccessToken.isNotBlank() && currentAccessToken == unauthorizedAccessToken
