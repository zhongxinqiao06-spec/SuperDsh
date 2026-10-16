package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.PersonalModelSelection
import com.agentsanywhere.app.api.ProductModelCatalog
import com.agentsanywhere.app.api.ServerAgent
import com.agentsanywhere.app.api.DevicesApi
import com.agentsanywhere.app.api.FilesApi
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.api.TestHttpServer
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64
import org.json.JSONArray
import com.agentsanywhere.app.feature.auth.allowsDestination
import com.agentsanywhere.app.navigation.AppDestination

class ServerAgentSessionTest {
    @Test fun usingModelsDoesNotGrantPersonalCredentialManagement() {
        assertFalse(setOf("models.use").allowsDestination(AppDestination.PersonalModels))
        assertTrue(setOf("models.personal.manage").allowsDestination(AppDestination.PersonalModels))
    }
    @Test fun offlineHistoryAndDisconnectedSessionsNeverEnableRemoteMutations() {
        val connected = com.agentsanywhere.app.feature.sessiondetail.SessionDetailState(
            initialized = true,
            realtime = com.agentsanywhere.app.feature.sessiondetail.SessionRealtimeState(connected = true),
        )
        assertTrue(connected.remoteActionsAllowed)
        assertFalse(connected.copy(offlineHistory = true).remoteActionsAllowed)
        assertFalse(connected.copy(initialized = false).remoteActionsAllowed)
        assertFalse(connected.copy(realtime = connected.realtime.copy(connected = false)).remoteActionsAllowed)
    }
    @Test fun serverDraftUsesOnlyServerPreparedTargetAndKeepsMainConversation() {
        val draft = serverAgentDraft(ServerAgent("running", "connector", "dsh", "project", null),
            NewSessionSelections("model", "permission"), setOf("existing"), true, "Server Agent", "Server workspace")
        assertEquals("connector", draft.connectorId)
        assertEquals("project", draft.projectId)
        assertNull(draft.cwd)
        assertEquals("server-agent", draft.executorKind)
        assertEquals("Server workspace", draft.previewSession().workspaceLabel)
        assertEquals("server-agent", draft.previewSession().executorKind)
        val request = draft.firstMessageRequest(" hello ", draft.selections, emptyList(), "client-id")
        assertEquals("model", request.selections.model)
        assertEquals("server-agent", request.executorKind)
        assertNull(validateNewSessionDraft(request))
        assertNotNull(validateNewSessionDraft(request.copy(projectId = "")))
        assertNotNull(validateNewSessionDraft(request.copy(executorKind = "desktop")))
        try {
            serverAgentDraft(ServerAgent("starting", "connector", "dsh", "project", null), NewSessionSelections(), emptySet(), true, "", "")
            fail("Do not open a conversation before the real runtime is ready")
        } catch (_: IllegalStateException) { }
    }

    @Test fun nativeServerWorkspaceIsResolvedByOwnedProjectAndNotSentAsClientCwd() = runBlocking {
        for (path in listOf("D:\\项目\\SuperDsh 数据\\用户\\workspace", "/srv/superdsh/用户工作区/workspace")) {
            val server = TestHttpServer()
            try {
                var calls = 0
                var connectorId = "connector"
                var runtimeRejected = false
                var outcomeUnknown = false
                server.route("/api/v2/projects") { request ->
                    assertEquals("GET", request.method)
                    assertEquals("Bearer account-token", request.headers["authorization"])
                    val project = JSONObject().put("id", "project").put("userId", "user")
                        .put("connectorId", connectorId).put("name", "Workspace").put("workspacePath", path)
                    200 to JSONObject().put("projects", JSONArray().put(project)).toString()
                }
                server.route("/api/v2/sessions/create-and-start") { request ->
                    calls++
                    if (outcomeUnknown) {
                        return@route 409 to JSONObject().put("code", "session_create_outcome_unknown")
                            .put("detail", "Create outcome unknown; refresh sessions before retrying.")
                            .put("sessionId", "possibly-created").toString()
                    }
                    val body = JSONObject(request.body)
                    assertEquals("project", body.getString("projectId"))
                    assertEquals("connector", body.getString("connectorId"))
                    assertEquals("model", body.getJSONObject("selections").getString("model"))
                    assertFalse(body.has("cwd"))
                    val session = JSONObject().put("id", "created").put("connectorId", "connector")
                        .put("projectId", "project").put("cwd", path).put("runtime", "dsh")
                        .put("executorKind", "server-agent")
                    val response = JSONObject().put("session", session)
                    if (runtimeRejected) response.put("connectorResult", JSONObject().put("ok", false)
                        .put("error", JSONObject().put("code", "invalid_model").put("message", "Select an available model.")))
                    200 to response.toString()
                }
                val controller = SessionsController(SessionsApi(), DevicesApi(), FilesApi(), object : AuthSessionReader {
                    override fun readServerUrl() = server.origin
                    override fun readAccessToken() = "account-token"
                })
                val draft = serverAgentDraft(ServerAgent("running", "connector", "dsh", "project", null),
                    NewSessionSelections("model", "permission"), emptySet(), true, "Agent", "Workspace")
                    .firstMessageRequest("hello", NewSessionSelections("model", "permission"), emptyList(), "client-id")
                val result = controller.createAndStartSession(draft, emptyList())
                assertTrue(result.toString(), result is NewSessionCreateOutcome.Created)
                assertEquals(path, (result as NewSessionCreateOutcome.Created).session.cwd)
                assertEquals(1, calls)
                runtimeRejected = true
                val failed = controller.createAndStartSession(draft, emptyList())
                assertTrue(failed is NewSessionCreateOutcome.Failed)
                assertEquals("Select an available model.", (failed as NewSessionCreateOutcome.Failed).error.message)
                assertEquals(2, calls)
                outcomeUnknown = true
                val unknown = controller.createAndStartSession(draft, emptyList())
                assertTrue(unknown is NewSessionCreateOutcome.Failed)
                assertTrue((unknown as NewSessionCreateOutcome.Failed).outcomeUnknown)
                assertEquals(3, calls)
                connectorId = "another-device"
                val rejected = controller.createAndStartSession(draft, emptyList())
                assertTrue(rejected is NewSessionCreateOutcome.Failed)
                assertEquals(3, calls)
            } finally { server.close() }
        }
    }

    @Test fun recoveringCreateRequiresThisRequestsAcceptedUserMessage() {
        val message = com.agentsanywhere.app.api.RemoteTimelineItem(
            id = "message", sessionId = "session", type = "message", status = "completed",
            role = "user", text = "hello", content = JSONObject(),
            source = JSONObject().put("clientMessageId", "request-a"),
            orderSeq = 1, revision = 1, updatedSeq = 1, createdAt = "", updatedAt = null,
        )
        assertTrue(hasAcceptedCreateMessage(listOf(message), "request-a"))
        assertFalse(hasAcceptedCreateMessage(listOf(message), "request-b"))
        assertFalse(hasAcceptedCreateMessage(listOf(message.copy(role = "assistant")), "request-a"))
        assertFalse(hasAcceptedCreateMessage(listOf(message.copy(status = "failed")), "request-a"))
        assertFalse(hasAcceptedCreateMessage(emptyList(), "request-a"))
        assertFalse(hasAcceptedCreateMessage(listOf(message), ""))
    }

    @Test fun accountScopeIncludesCanonicalOriginAndStableUserWithoutHashCodeCollisions() {
        assertEquals(accountDataScope("https://example.test/", "u"), accountDataScope("https://example.test", "u"))
        assertNotEquals(accountDataScope("https://one.test", "u"), accountDataScope("https://two.test", "u"))
        assertNotEquals(accountDataScope("https://one.test", "FB"), accountDataScope("https://one.test", "Ea"))
    }

    @Test fun defaultIsMatchedToRuntimeSelectionAndMissingSelectionNeverChoosesFirst() {
        val scope = "a".repeat(64)
        val route = "superdsh-$scope-personal-a"
        val preferredId = "dsh:model:" + Base64.getUrlEncoder().withoutPadding().encodeToString(
            JSONArray(listOf(route, "m", org.json.JSONObject.NULL)).toString().toByteArray(Charsets.UTF_8),
        )
        val catalog = NewSessionModelCatalog("dsh", 1, listOf(
            NewSessionModel("other", "other", "Other", null, true, emptyList(), emptyMap()),
            NewSessionModel("preferred", preferredId, "Preferred", null, false, emptyList(), mapOf("provider" to route, "model" to "m")),
        ), null)
        assertEquals(preferredId, catalog.defaultSelection(ProductModelCatalog(scope, PersonalModelSelection("personal-a", "m"))))
        assertNull(catalog.defaultSelection(ProductModelCatalog(scope, PersonalModelSelection("deleted", "m"))))
        assertNull(catalog.defaultSelection(ProductModelCatalog(null, PersonalModelSelection("missing", "m"))))
        assertNull(catalog.defaultSelection(ProductModelCatalog(scope, null)))
        assertEquals("Personal", catalog.models[1].sourceLabel(ProductModelCatalog(scope, null, mapOf("personal-a" to "personal")), "Personal", "Platform"))
        val duplicates = catalog.copy(models = listOf(catalog.models[1], catalog.models[1].copy(id = "duplicate")))
        assertNull(duplicates.defaultSelection(ProductModelCatalog(scope, PersonalModelSelection("personal-a", "m"))))
    }
}
