package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.ServerAgent
import com.agentsanywhere.app.feature.sessions.ATTACHMENT_CAPABILITY
import com.agentsanywhere.app.feature.sessions.NewSessionDraft
import com.agentsanywhere.app.feature.sessions.NewSessionModelCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionPermissionCatalog
import com.agentsanywhere.app.feature.sessions.NewSessionRuntimeCapabilities
import com.agentsanywhere.app.feature.sessions.NewSessionSelections
import com.agentsanywhere.app.feature.sessions.serverAgentDraft
import com.agentsanywhere.app.feature.sessions.sourceLabel
import com.agentsanywhere.app.feature.sessions.defaultSelection
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import kotlinx.coroutines.delay

@Composable
fun ServerAgentSessionScreen(
    knownSessionIds: Set<String>,
    onGetAgent: suspend () -> Result<ServerAgent>,
    onPrepareAgent: suspend () -> Result<ServerAgent>,
    onLoadCapabilities: suspend (String, String) -> Result<NewSessionRuntimeCapabilities>,
    onLoadModels: suspend (String, String) -> Result<NewSessionModelCatalog>,
    onLoadPermissions: suspend (String, String) -> Result<NewSessionPermissionCatalog>,
    onLoadProductCatalog: suspend () -> Result<com.agentsanywhere.app.api.ProductModelCatalog>,
    onPrepareSession: (NewSessionDraft) -> Unit,
    onPersonalModels: () -> Unit,
    onBack: () -> Unit,
) {
    var agent by remember { mutableStateOf<ServerAgent?>(null) }
    var models by remember { mutableStateOf<NewSessionModelCatalog?>(null) }
    var permissions by remember { mutableStateOf<NewSessionPermissionCatalog?>(null) }
    var capabilities by remember { mutableStateOf<NewSessionRuntimeCapabilities?>(null) }
    var productModels by remember { mutableStateOf<com.agentsanywhere.app.api.ProductModelCatalog?>(null) }
    var modelSelection by remember { mutableStateOf<String?>(null) }
    var permissionSelection by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableStateOf(0) }
    var expanded by remember { mutableStateOf<NewSessionConfigurationKey?>(null) }
    val personalLabel = stringResource(R.string.server_agent_personal_source)
    val platformLabel = stringResource(R.string.server_agent_platform_source)
    val deviceName = stringResource(R.string.server_agent_title)
    val workspaceLabel = stringResource(R.string.server_agent_workspace)
    val noModels = stringResource(R.string.server_agent_no_models)
    val canManagePersonalModels = "models.personal.manage" in com.agentsanywhere.app.feature.auth.LocalAccountPermissions.current

    LaunchedEffect(retry) {
        busy = true
        error = null
        models = null
        try {
            var current = onGetAgent().getOrThrow()
            if (!current.ready && current.status != "starting") current = onPrepareAgent().getOrThrow()
            agent = current
            while (current.status == "starting") {
                delay(2_000)
                current = onGetAgent().getOrThrow()
                agent = current
            }
            check(current.ready) { current.error ?: "Server Agent is unavailable." }
            val connectorId = requireNotNull(current.connectorId)
            val runtimeId = requireNotNull(current.runtimeId)
            capabilities = onLoadCapabilities(connectorId, runtimeId).getOrThrow()
            val catalog = onLoadModels(connectorId, runtimeId).getOrThrow()
            models = catalog
            val options = catalog.models.filter { it.enabled }.flatMap { model ->
                listOfNotNull(model.selectionId) + model.reasoningItems.filter { it.enabled }.map { it.selectionId }
            }
            val productCatalog = onLoadProductCatalog().getOrThrow()
            productModels = productCatalog
            modelSelection = modelSelection?.takeIf { it in options } ?: catalog.defaultSelection(productCatalog)
            val permissionCatalog = onLoadPermissions(connectorId, runtimeId).getOrThrow()
            permissions = permissionCatalog
            permissionSelection = permissionSelection?.takeIf { id -> permissionCatalog.permissions.any { it.selectionId == id && it.enabled } }
                ?: permissionCatalog.permissions.firstOrNull { it.default && it.enabled }?.selectionId
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            error = failure.message
        } finally {
            busy = false
        }
    }

    Column(Modifier.fillMaxSize().padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(Modifier.fillMaxWidth()) {
            TextButton(onClick = onBack) { Text(stringResource(R.string.common_back)) }
            Text(deviceName, color = LocalAAColors.current.ink, modifier = Modifier.padding(top = 14.dp))
        }
        Text(stringResource(R.string.server_agent_description), color = LocalAAColors.current.inkSoft)
        if (busy) {
            CircularProgressIndicator()
            Text(stringResource(R.string.server_agent_preparing))
        }
        error?.let {
            Text(it, color = LocalAAColors.current.errorText)
            OutlinedButton(onClick = { retry++ }) { Text(stringResource(R.string.common_retry)) }
        }
        val modelOptions = models?.models.orEmpty().flatMap { model ->
            val source = model.sourceLabel(productModels, personalLabel, platformLabel)
            val label = "${model.displayName} · $source"
            listOfNotNull(model.selectionId?.let { NewSessionConfigurationOption(it, label, enabled = model.enabled) }) +
                model.reasoningItems.map { NewSessionConfigurationOption(it.selectionId, "$label · ${it.displayName}", enabled = model.enabled && it.enabled) }
        }
        if (!busy && error == null) {
            NewSessionConfigurationCard(
                fields = listOf(
                    NewSessionConfigurationField(NewSessionConfigurationKey.Model, stringResource(R.string.new_session_model),
                        modelOptions.firstOrNull { it.id == modelSelection }?.label ?: noModels, modelSelection, modelOptions, true),
                    NewSessionConfigurationField(NewSessionConfigurationKey.Permission, stringResource(R.string.new_session_permission),
                        permissions?.permissions?.firstOrNull { it.selectionId == permissionSelection }?.displayName.orEmpty(), permissionSelection,
                        permissions?.permissions.orEmpty().map { NewSessionConfigurationOption(it.selectionId, it.displayName, enabled = it.enabled) }, true),
                ), expanded = expanded, onToggle = { expanded = if (expanded == it) null else it },
                onDismiss = { expanded = null }, onSelect = { key, id ->
                    if (key == NewSessionConfigurationKey.Model) modelSelection = id else permissionSelection = id
                    expanded = null
                },
            )
            Text(workspaceLabel, color = LocalAAColors.current.inkSoft)
        }
        if (canManagePersonalModels) {
            OutlinedButton(onClick = onPersonalModels) { Text(stringResource(R.string.personal_models_title)) }
        }
        Button(enabled = !busy && error == null && agent?.ready == true && modelSelection != null, onClick = {
            val current = agent ?: return@Button
            onPrepareSession(serverAgentDraft(current, NewSessionSelections(modelSelection, permissionSelection), knownSessionIds,
                capabilities?.find(ATTACHMENT_CAPABILITY, requireNotNull(current.runtimeId), "dsh")?.usable == true,
                deviceName, workspaceLabel))
        }) { Text(stringResource(R.string.new_session_start_chat)) }
    }
}
