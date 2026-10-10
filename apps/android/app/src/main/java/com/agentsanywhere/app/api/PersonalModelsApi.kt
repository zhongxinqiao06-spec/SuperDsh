package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject

data class PersonalModel(
    val modelId: String, val name: String,
    val contextWindow: Long? = null, val maxTokens: Long? = null,
    val inputTypes: List<String> = listOf("text"),
)
data class PersonalProvider(
    val providerId: String,
    val name: String,
    val protocol: String,
    val baseUrl: String,
    val models: List<PersonalModel>,
    val enabled: Boolean,
    val apiKeyConfigured: Boolean,
)
data class PersonalModelSelection(val providerId: String, val modelId: String)
data class ProductModelCatalog(
    val scope: String?, val default: PersonalModelSelection?,
    val providerSources: Map<String, String> = emptyMap(),
)
data class PersonalProviderWrite(
    val name: String,
    val protocol: String,
    val baseUrl: String,
    val models: List<PersonalModel>,
    val enabled: Boolean = true,
    val apiKey: String? = null,
) {
    internal fun json(): JSONObject = JSONObject()
        .put("name", name.trim())
        .put("protocol", protocol)
        .put("baseUrl", baseUrl.trim().trimEnd('/'))
        .put("enabled", enabled)
        .put("models", JSONArray(models.map { model ->
            JSONObject().put("modelId", model.modelId.trim()).put("name", model.name.trim())
                .put("inputTypes", JSONArray(model.inputTypes))
                .apply {
                    model.contextWindow?.let { put("contextWindow", it) }
                    model.maxTokens?.let { put("maxTokens", it) }
                }
        }))
        .apply { apiKey?.takeIf(String::isNotBlank)?.let { put("apiKey", it) } }
}

class PersonalModelsApi(private val client: ApiClient = ApiClient()) {
    fun list(serverUrl: String, token: String): List<PersonalProvider> =
        client.getJson(serverUrl, "/models/personal/providers", token)
            .optJSONArray("providers").toObjectList { provider() }

    fun save(serverUrl: String, token: String, providerId: String?, write: PersonalProviderWrite): PersonalProvider {
        val json = if (providerId == null) {
            client.postJson(serverUrl, "/models/personal/providers", write.json(), token)
        } else {
            client.patchJson(serverUrl, "/models/personal/providers/${providerId.urlEncode()}", write.json(), token)
        }
        return (json.optJSONObject("provider") ?: json).provider()
    }

    fun remove(serverUrl: String, token: String, providerId: String) {
        client.deleteJson(serverUrl, "/models/personal/providers/${providerId.urlEncode()}", token)
    }

    fun verify(serverUrl: String, token: String, providerId: String) {
        val response = client.postJson(serverUrl, "/models/personal/providers/${providerId.urlEncode()}/verify", JSONObject(), token)
        if (response.has("ok") && !response.optBoolean("ok")) {
            throw ApiException(response.optString("message", "Model verification failed."))
        }
    }

    fun default(serverUrl: String, token: String): PersonalModelSelection? =
        client.getJson(serverUrl, "/models/personal/default", token).optJSONObject("selection")?.let {
            PersonalModelSelection(it.getString("providerId"), it.getString("modelId"))
        }

    fun catalog(serverUrl: String, token: String): ProductModelCatalog {
        val json = client.getJson(serverUrl, "/models/catalog", token)
        return ProductModelCatalog(json.optNullableString("scope"), json.optJSONObject("default")?.let {
            PersonalModelSelection(it.getString("providerId"), it.getString("modelId"))
        }, json.optJSONArray("providers").toObjectList {
            getString("providerId") to (optNullableString("source") ?: "platform")
        }.toMap())
    }

    fun setDefault(serverUrl: String, token: String, selection: PersonalModelSelection?) {
        client.putJson(serverUrl, "/models/personal/default", JSONObject().put("selection", selection?.let {
            JSONObject().put("providerId", it.providerId).put("modelId", it.modelId)
        } ?: JSONObject.NULL), token)
    }

    private fun JSONObject.provider() = PersonalProvider(
        providerId = getString("providerId"), name = getString("name"), protocol = getString("protocol"),
        baseUrl = getString("baseUrl"), enabled = optBoolean("enabled", true),
        apiKeyConfigured = optBoolean("apiKeyConfigured", false),
        models = optJSONArray("models").toObjectList {
            PersonalModel(getString("modelId"), getString("name"),
                if (isNull("contextWindow")) null else optLong("contextWindow").takeIf { it > 0 },
                if (isNull("maxTokens")) null else optLong("maxTokens").takeIf { it > 0 },
                optJSONArray("inputTypes")?.let { values -> List(values.length()) { values.getString(it) } } ?: listOf("text"),
            )
        },
    )
}
