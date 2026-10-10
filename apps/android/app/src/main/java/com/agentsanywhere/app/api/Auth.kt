package com.agentsanywhere.app.api

import org.json.JSONObject

class AuthApi(
    private val client: ApiClient = ApiClient(),
) {
    fun login(serverUrl: String, identifier: String, password: String): AuthResponse = client.postJson(
        serverUrl = serverUrl,
        path = "/auth/login",
        body = JSONObject().put("identifier", identifier.trim().lowercase())
            .put("password", password).put("clientType", "native").put("clientName", "SuperDsh Android"),
    ).toAuthResponse()

    fun refresh(serverUrl: String, refreshToken: String): AuthResponse = client.postJson(
        serverUrl = serverUrl,
        path = "/auth/refresh",
        body = JSONObject().put("refreshToken", refreshToken).put("clientName", "SuperDsh Android"),
    ).toAuthResponse()

    fun logout(serverUrl: String, refreshToken: String) {
        client.postJson(serverUrl, "/auth/logout", JSONObject().put("refreshToken", refreshToken))
    }

    fun me(
        serverUrl: String,
        token: String,
    ): AuthMeResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/auth/me",
            authorizationToken = token,
        ).toAuthMeResponse()
    }

    fun authConfig(serverUrl: String): AuthConfigResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/auth/config",
        ).toAuthConfigResponse()
    }

    fun requireHealthyServer(serverUrl: String) {
        val health = client.getJson(serverUrl = serverUrl, path = "/health")
        if (health.optString("status") != "ok") {
            throw ApiException("The address did not return a healthy Agents Anywhere server.")
        }
    }

    fun requireWebLoginHost(webOrigin: String) {
        client.requireHtmlDocument(serverUrl = webOrigin)
    }

    fun oauthToken(
        serverUrl: String,
        code: String,
        codeVerifier: String,
    ): OAuthTokenResponse {
        return client.postForm(
            serverUrl = serverUrl,
            path = "/oauth/token",
            fields = linkedMapOf(
                "grant_type" to "authorization_code",
                "code" to code,
                "client_id" to "agents-anywhere-mobile",
                "redirect_uri" to "agents-anywhere://oauth/callback",
                "code_verifier" to codeVerifier,
            ),
        ).toOAuthTokenResponse()
    }

    fun requestMobileLogin(
        serverUrl: String,
        userId: String,
        loginToken: String,
        deviceName: String?,
    ): MobileLoginStatusResponse {
        val body = JSONObject()
            .put("userId", userId)
            .put("loginToken", loginToken)
        if (!deviceName.isNullOrBlank()) {
            body.put("deviceName", deviceName)
        }
        return try {
            client.postJson(
                serverUrl = serverUrl,
                path = "/auth/mobile-login/request",
                body = body,
            ).toMobileLoginStatusResponse()
        } catch (exc: ApiException) {
            if (exc.statusCode == 401) {
                throw ApiException("Invalid or expired QR code.", exc.statusCode, exc)
            }
            throw exc
        }
    }

    fun mobileLoginStatus(
        serverUrl: String,
        loginToken: String,
    ): MobileLoginStatusResponse {
        return try {
            client.postJson(
                serverUrl = serverUrl,
                path = "/auth/mobile-login/status",
                body = JSONObject().put("loginToken", loginToken),
            ).toMobileLoginStatusResponse()
        } catch (exc: ApiException) {
            if (exc.statusCode == 401 || exc.statusCode == 404) {
                throw ApiException("Invalid or expired QR code.", exc.statusCode, exc)
            }
            throw exc
        }
    }

    fun exchangeMobileLogin(
        serverUrl: String,
        userId: String,
        loginToken: String,
    ): MobileLoginExchangeResponse {
        return try {
            client.postJson(
                serverUrl = serverUrl,
                path = "/auth/mobile-login/exchange",
                body = JSONObject()
                    .put("userId", userId)
                    .put("loginToken", loginToken),
            ).toMobileLoginExchangeResponse()
        } catch (exc: ApiException) {
            if (exc.statusCode == 401) {
                throw ApiException("Invalid or expired QR code.", exc.statusCode, exc)
            }
            throw exc
        }
    }

    fun updateAvatar(
        serverUrl: String,
        token: String,
        avatar: String,
    ): AuthMeResponse {
        return client.putJson(
            serverUrl = serverUrl,
            path = "/auth/me/avatar",
            body = JSONObject().put("avatar", avatar),
            authorizationToken = token,
        ).toAuthMeResponse()
    }

    fun clearAvatar(
        serverUrl: String,
        token: String,
    ): AuthMeResponse {
        return client.deleteJson(
            serverUrl = serverUrl,
            path = "/auth/me/avatar",
            authorizationToken = token,
        ).toAuthMeResponse()
    }

    fun updateDisplayName(serverUrl: String, token: String, displayName: String): AuthMeResponse {
        return client.putJson(
            serverUrl = serverUrl,
            path = "/auth/me/profile",
            body = JSONObject().put("displayName", displayName.trim()),
            authorizationToken = token,
        ).toAuthMeResponse()
    }

    fun sendEmailCode(serverUrl: String, token: String, email: String): EmailCodeResponse {
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/auth/email-code",
            body = JSONObject().put("email", email.trim()).put("purpose", "bind"),
            authorizationToken = token,
        )
        return EmailCodeResponse(
            expiresIn = response.getInt("expiresIn"),
            retryAfter = response.getInt("retryAfter"),
        )
    }

    fun bindEmail(serverUrl: String, token: String, email: String, code: String?): AuthMeResponse {
        val body = JSONObject().put("email", email.trim())
        if (!code.isNullOrBlank()) body.put("code", code.trim())
        return client.putJson(
            serverUrl = serverUrl,
            path = "/auth/me/email",
            body = body,
            authorizationToken = token,
        ).toAuthMeResponse()
    }

    fun changePassword(
        serverUrl: String,
        token: String,
        newPassword: String,
    ) {
        client.postJson(
            serverUrl = serverUrl,
            path = "/auth/change-password",
            body = JSONObject().put("newPassword", newPassword),
            authorizationToken = token,
        )
    }

    private fun JSONObject.toAuthConfigResponse(): AuthConfigResponse {
        return AuthConfigResponse(
            needsBootstrap = optBoolean("needsBootstrap", false),
            emailVerificationRequired = optBoolean("emailVerificationRequired", false),
            registrationOpen = optBoolean("registrationOpen", false),
            oauthRegistrationOpen = optBoolean("oauthRegistrationOpen", false),
            oauthEnabled = optBoolean("oauthEnabled", false),
            oauthProviderLabel = optNullableString("oauthProviderLabel"),
            setupTokenExpiresAt = optNullableString("setupTokenExpiresAt"),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.toOAuthTokenResponse(): OAuthTokenResponse {
        return OAuthTokenResponse(
            accessToken = getString("access_token"),
            tokenType = optString("token_type", "Bearer"),
            expiresIn = getInt("expires_in"),
            scope = optString("scope"),
            refreshToken = optNullableString("refresh_token"),
        )
    }

    private fun JSONObject.toAuthMeResponse(): AuthMeResponse {
        return AuthMeResponse(
            userId = getString("userId"),
            email = optNullableString("email"),
            displayName = optString("displayName", ""),
            emailVerified = optBoolean("emailVerified", false),
            username = optString("username", ""),
            roles = stringList("roles"),
            permissions = stringList("permissions").toSet(),
            authzVersion = optLong("authzVersion", 0),
            resetRequired = optBoolean("resetRequired", false),
            role = getString("role"),
            disabled = optBoolean("disabled", false),
            avatar = optNullableString("avatar"),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.toAuthResponse(): AuthResponse {
        return AuthResponse(
            userId = getString("userId"),
            email = optNullableString("email"),
            displayName = optString("displayName", ""),
            emailVerified = optBoolean("emailVerified", false),
            username = optString("username", ""),
            roles = stringList("roles"),
            permissions = stringList("permissions").toSet(),
            authzVersion = optLong("authzVersion", 0),
            resetRequired = optBoolean("resetRequired", false),
            refreshToken = optNullableString("refreshToken"),
            expiresIn = optInt("expiresIn", 900),
            role = getString("role"),
            accessToken = getString("accessToken"),
            tokenType = optString("tokenType", "bearer"),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.toMobileLoginStatusResponse(): MobileLoginStatusResponse {
        return MobileLoginStatusResponse(
            status = getString("status"),
            userId = optNullableString("userId"),
            deviceName = optNullableString("deviceName"),
            expiresAt = optNullableString("expiresAt"),
            requestedAt = optNullableString("requestedAt"),
            approvedAt = optNullableString("approvedAt"),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.toMobileLoginExchangeResponse(): MobileLoginExchangeResponse {
        return MobileLoginExchangeResponse(
            auth = getJSONObject("auth").toAuthResponse(),
            refreshToken = getString("refreshToken"),
            expiresAt = getString("expiresAt"),
            serverTime = getString("serverTime"),
        )
    }

    private fun JSONObject.optNullableString(name: String): String? {
        if (!has(name) || isNull(name)) return null
        return optString(name).takeIf { it.isNotBlank() }
    }

    private fun JSONObject.stringList(name: String): List<String> {
        val values = optJSONArray(name) ?: return emptyList()
        return (0 until values.length()).mapNotNull { values.optString(it).takeIf(String::isNotBlank) }
    }

}
