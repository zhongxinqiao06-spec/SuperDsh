package com.agentsanywhere.app.api

import org.json.JSONObject

data class BusinessAgentDefinition(val id: String, val name: String, val description: String, val version: Int)
data class OfficeArtifact(val fileId: String, val name: String, val mediaType: String, val size: Long, val sha256: String,
    val planVersion: Int, val previousArtifactId: String?, val draft: Boolean, val diagnostics: List<String>,
    val previewFileId: String?, val previewSha256: String?, val previewName: String?, val previewMediaType: String? = null)
data class OfficeTaskPlan(val id: String, val title: String, val version: Int, val state: String, val stage: String, val summary: String, val error: String?)
data class OfficeSessionResources(val agentName: String?, val artifacts: List<OfficeArtifact>, val plans: List<OfficeTaskPlan>)

internal fun JSONObject.toBusinessAgent() = BusinessAgentDefinition(getString("id"), getString("name"), optString("description"), optInt("version", 1))
internal fun JSONObject.toOfficeArtifact(): OfficeArtifact {
    val revision = optJSONObject("revision")
    val preview = optJSONObject("preview")
    val diagnostics = optJSONArray("diagnostics")
    return OfficeArtifact(getString("fileId"), getString("name"), getString("mediaType"), getLong("size"), getString("sha256"),
        revision?.optInt("planVersion", 1) ?: 1, revision?.optNullableString("previousArtifactId"), optBoolean("draft"),
        if (diagnostics == null) emptyList() else List(diagnostics.length()) { diagnostics.optString(it) },
        preview?.optNullableString("fileId"), preview?.optNullableString("sha256"), preview?.optNullableString("name"), preview?.optNullableString("mediaType"))
}
internal fun JSONObject.toOfficePlan() = OfficeTaskPlan(getString("id"), getString("title"), getInt("version"), getString("state"), optString("stage"), optString("summary"), optNullableString("error"))
