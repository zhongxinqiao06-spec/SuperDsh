package com.agentsanywhere.app.api

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ServerAgentApiTest {
    @Test fun preparationUsesNativeAuthenticatedApiAndOnlyRunningWithIdentitiesIsReady() {
        val server = TestHttpServer()
        try {
            val methods = mutableListOf<String>()
            server.route("/api/v2/server-agent") { request ->
                assertEquals("Bearer account-token", request.headers["authorization"])
                methods += request.method
                if (request.method == "POST") 202 to """{"agent":{"status":"starting","connectorId":"server","runtimeId":"dsh","projectId":"p","error":null}}"""
                else 200 to """{"agent":{"status":"running","connectorId":"server","runtimeId":"dsh","projectId":"p","error":null}}"""
            }
            val api = ServerAgentApi()
            assertFalse(api.prepare(server.origin, "account-token").ready)
            assertTrue(api.get(server.origin, "account-token").ready)
            assertEquals(listOf("POST", "GET"), methods)
            assertFalse(ServerAgent("running", null, "dsh", "p", null).ready)
            assertEquals("diagnostic", api.parse(JSONObject("""{"agent":{"status":"error","error":{"message":"diagnostic"}}}""")).error)
        } finally { server.close() }
    }

    @Test fun personalProviderWritesFullProtocolAndPreservesMissingKeyWithNoKeyReadback() {
        val server = TestHttpServer()
        try {
            val provider = """{"providerId":"personal-a","name":"My DeepSeek","protocol":"openai-completions","baseUrl":"https://example.test/v1","models":[{"modelId":"deepseek-chat","name":"DeepSeek","contextWindow":1000,"maxTokens":500,"inputTypes":["text","image"]}],"enabled":true,"apiKeyConfigured":true}"""
            var posted = JSONObject()
            var patched = JSONObject()
            server.route("/api/v2/models/personal/providers") { request ->
                assertEquals("Bearer test", request.headers["authorization"])
                if (request.method == "GET") 200 to "{\"providers\":[$provider]}"
                else { posted = JSONObject(request.body); 200 to provider }
            }
            server.route("/api/v2/models/personal/providers/personal-a") { request ->
                patched = JSONObject(request.body)
                200 to provider
            }
            server.route("/api/v2/models/personal/providers/personal-a/verify") { 200 to "{\"ok\":true}" }
            server.route("/api/v2/models/personal/default") { request ->
                if (request.method == "PUT") {
                    assertEquals("personal-a", JSONObject(request.body).getJSONObject("selection").getString("providerId"))
                }
                200 to """{"selection":{"providerId":"personal-a","modelId":"deepseek-chat"}}"""
            }
            val api = PersonalModelsApi()
            val view = api.list(server.origin, "test").single()
            assertTrue(view.apiKeyConfigured)
            assertEquals(1000L, view.models.single().contextWindow)
            api.save(server.origin, "test", null, PersonalProviderWrite(view.name, view.protocol, view.baseUrl, view.models, apiKey = "test-key"))
            assertEquals("test-key", posted.getString("apiKey"))
            api.save(server.origin, "test", view.providerId, PersonalProviderWrite(view.name, view.protocol, view.baseUrl, view.models))
            assertFalse(patched.has("apiKey"))
            assertFalse(patched.has("clearApiKey"))
            assertEquals(500L, patched.getJSONArray("models").getJSONObject(0).getLong("maxTokens"))
            assertEquals(2, patched.getJSONArray("models").getJSONObject(0).getJSONArray("inputTypes").length())
            api.verify(server.origin, "test", view.providerId)
            api.setDefault(server.origin, "test", PersonalModelSelection(view.providerId, "deepseek-chat"))
            assertEquals(view.providerId, api.default(server.origin, "test")?.providerId)
        } finally { server.close() }
    }

    @Test fun historyFallsBackOnlyForNetworkLossAndNeverForAuthOrServerFailure() {
        val server = TestHttpServer()
        val values = mutableMapOf<String, JSONObject>()
        var scope = "origin-user-a"
        val cache = object : HistoryCache {
            override fun scope(serverUrl: String): String = scope
            override fun read(scope: String, path: String) = values["$scope|$path"]?.let { JSONObject(it.toString()) }
            override fun write(scope: String, path: String, value: JSONObject) { values["$scope|$path"] = JSONObject(value.toString()) }
        }
        val client = ApiClient()
        try {
            server.route("/api/v2/history") { 200 to "{\"history\":\"user-a\"}" }
            assertEquals("user-a", client.historyJson(server.origin, "/history", "a", cache).getString("history"))
            for (status in listOf(401, 403, 404, 503)) {
                server.route("/api/v2/history") { status to "{\"detail\":\"failed\"}" }
                try { client.historyJson(server.origin, "/history", "a", cache); fail("Must not substitute cached data") }
                catch (error: ApiException) { assertEquals(status, error.statusCode) }
            }
        } finally { server.close() }
        val loaded = client.historyJson(server.origin, "/history", "a", cache)
        assertTrue(loaded.getBoolean("cachedOffline"))
        assertEquals("user-a", loaded.getString("history"))
        scope = "origin-user-b"
        try { client.historyJson(server.origin, "/history", "b", cache); fail("Must not expose another account's cache") }
        catch (error: ApiException) { assertNotNull(error.cause) }
    }
}
