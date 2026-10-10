package com.agentsanywhere.app.api

import org.json.JSONObject
import java.io.IOException

interface HistoryCache {
    fun scope(serverUrl: String): String?
    fun read(scope: String, path: String): JSONObject?
    fun write(scope: String, path: String, value: JSONObject)
}

internal fun ApiClient.historyJson(
    serverUrl: String, path: String, token: String, cache: HistoryCache?,
): JSONObject {
    val scope = cache?.scope(serverUrl)
    return try {
        getJson(serverUrl, path, token).also { if (scope != null) cache.write(scope, path, it) }
    } catch (error: ApiException) {
        // Never hide invalid credentials, permission changes, removed content or server errors.
        if (error.cause !is IOException || scope == null || cache.scope(serverUrl) != scope) throw error
        cache.read(scope, path)?.put("cachedOffline", true) ?: throw error
    }
}
