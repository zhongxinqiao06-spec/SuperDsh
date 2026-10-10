package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.PersonalModelSelection
import com.agentsanywhere.app.api.ProductModelCatalog
import com.agentsanywhere.app.api.ServerAgent
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
        assertEquals("/workspace", draft.cwd)
        assertEquals("server-agent", draft.executorKind)
        assertEquals("Server workspace", draft.previewSession().workspaceLabel)
        assertEquals("server-agent", draft.previewSession().executorKind)
        assertEquals("model", draft.firstMessageRequest(" hello ", draft.selections, emptyList(), "client-id").selections.model)
        try {
            serverAgentDraft(ServerAgent("starting", "connector", "dsh", "project", null), NewSessionSelections(), emptySet(), true, "", "")
            fail("Do not open a conversation before the real runtime is ready")
        } catch (_: IllegalStateException) { }
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
