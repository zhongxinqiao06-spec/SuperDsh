package com.agentsanywhere.app.api

import org.json.JSONObject

data class ServerAgent(
    val status: String,
    val connectorId: String?,
    val runtimeId: String?,
    val projectId: String?,
    val error: String?,
) {
    val ready: Boolean get() = status == "running" && !connectorId.isNullOrBlank() &&
        !runtimeId.isNullOrBlank() && !projectId.isNullOrBlank()
}

class ServerAgentApi(private val client: ApiClient = ApiClient()) {
    fun get(serverUrl: String, token: String): ServerAgent = parse(
        client.getJson(serverUrl, "/server-agent", token),
    )

    fun prepare(serverUrl: String, token: String): ServerAgent = parse(
        client.postJson(serverUrl, "/server-agent", JSONObject(), token, readTimeoutSeconds = 60),
    )

    internal fun parse(response: JSONObject): ServerAgent {
        val agent = response.getJSONObject("agent")
        val error = agent.opt("error")
        return ServerAgent(
            status = agent.getString("status"),
            connectorId = agent.optNullableString("connectorId"),
            runtimeId = agent.optNullableString("runtimeId"),
            projectId = agent.optNullableString("projectId"),
            error = when (error) {
                is JSONObject -> error.optNullableString("message") ?: error.optNullableString("code")
                is String -> error.takeIf(String::isNotBlank)
                else -> null
            },
        )
    }
}

