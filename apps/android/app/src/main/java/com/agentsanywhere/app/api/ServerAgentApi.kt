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
    fun definitions(serverUrl: String, token: String): List<BusinessAgentDefinition> {
        val result = mutableListOf<BusinessAgentDefinition>()
        var page = 1
        while (page <= 100) {
            val response = client.getJson(serverUrl, "/agents?page=$page&pageSize=100", token)
            val items = response.optJSONArray("items") ?: break
            for (index in 0 until items.length()) result += items.getJSONObject(index).toBusinessAgent()
            if (result.size >= response.optInt("total", result.size) || items.length() == 0) break
            page++
        }
        return result
    }
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

