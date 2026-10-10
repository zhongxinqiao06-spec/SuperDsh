package com.agentsanywhere.app.feature.sessiondetail

import android.content.Context
import com.agentsanywhere.app.api.HistoryCache
import com.agentsanywhere.app.api.normalizeServerOrigin
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.sessions.accountDataScope
import org.json.JSONObject

class AccountHistoryCache(context: Context, private val sessionStore: AuthSessionStore) : HistoryCache {
    private val appContext = context.applicationContext
    override fun scope(serverUrl: String): String? = if (
        sessionStore.readUserId().isNotBlank() &&
        normalizeServerOrigin(serverUrl) == normalizeServerOrigin(sessionStore.readServerUrl())
    ) accountDataScope(serverUrl, sessionStore.readUserId()) else null
    private fun preferences(scope: String) = appContext.getSharedPreferences("session-history-$scope", Context.MODE_PRIVATE)

    override fun read(scope: String, path: String): JSONObject? = preferences(scope)
        .getString(path, null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    override fun write(scope: String, path: String, value: JSONObject) {
        val serialized = value.toString()
        if (serialized.toByteArray(Charsets.UTF_8).size > MAX_SNAPSHOT_BYTES) return
        val prefs = preferences(scope)
        val editor = prefs.edit()
        val snapshots = prefs.all.keys.filter { "/snapshot?" in it }
        if ("/snapshot?" in path && path !in snapshots && snapshots.size >= MAX_SNAPSHOTS) {
            snapshots.firstOrNull()?.let(editor::remove)
        }
        editor.putString(path, serialized).apply()
    }

    companion object {
        private const val MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
        private const val MAX_SNAPSHOTS = 20
    }
}
