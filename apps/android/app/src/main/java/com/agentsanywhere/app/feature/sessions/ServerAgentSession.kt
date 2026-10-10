package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.ServerAgent
import com.agentsanywhere.app.api.ProductModelCatalog

fun serverAgentDraft(
    agent: ServerAgent,
    selections: NewSessionSelections,
    knownSessionIds: Set<String>,
    attachmentsEnabled: Boolean,
    deviceName: String,
    workspaceLabel: String,
): NewSessionDraft {
    check(agent.ready) { "The server Agent is not ready." }
    return NewSessionDraft(
        connectorId = requireNotNull(agent.connectorId),
        projectId = requireNotNull(agent.projectId),
        runtime = "dsh", runtimeId = requireNotNull(agent.runtimeId), runtimeType = "dsh",
        runtimeLabel = "DSH", runtimeName = "DSH", title = null,
        cwd = "/workspace", deviceName = deviceName, knownSessionIds = knownSessionIds,
        selections = selections, attachmentsEnabled = attachmentsEnabled,
        executorKind = "server-agent", workspaceLabel = workspaceLabel,
    )
}

fun NewSessionModel.sourceLabel(personal: String, platform: String): String? = when (metadata["source"]) {
    "personal" -> personal
    "platform" -> platform
    else -> null
}

fun NewSessionModel.sourceLabel(product: ProductModelCatalog?, personal: String, platform: String): String {
    sourceLabel(personal, platform)?.let { return it }
    val scope = product?.scope ?: return platform
    val provider = product.providerSources.keys.singleOrNull { id ->
        metadata["provider"] == "superdsh-$scope-$id" || metadata["providerId"] == id
    }
    return if (product.providerSources[provider] == "personal") personal else platform
}

fun NewSessionModelCatalog.defaultSelection(product: ProductModelCatalog): String? {
    val selected = product.default ?: return null
    val scope = product.scope?.takeIf { it.matches(Regex("[a-f0-9]{64}")) }
    val providerRoute = scope?.let { "superdsh-$it-${selected.providerId}" }
    val matching = models.filter { model ->
        model.enabled && (
            (model.metadata["providerId"] == selected.providerId && model.metadata["modelId"] == selected.modelId) ||
                (providerRoute != null && model.metadata["provider"] == providerRoute && model.metadata["model"] == selected.modelId)
            )
    }.singleOrNull() ?: return null
    // Runtime-issued wire IDs remain opaque; the application never recreates them.
    return matching.selectionId?.takeIf(String::isNotBlank)
        ?: matching.reasoningItems.singleOrNull { it.enabled && it.default }?.selectionId
}
