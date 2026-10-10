package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.PersonalModelSelection
import com.agentsanywhere.app.api.PersonalModelsApi
import com.agentsanywhere.app.api.PersonalProviderWrite
import com.agentsanywhere.app.api.ServerAgentApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class ServerAgentController(
    private val agents: ServerAgentApi,
    private val models: PersonalModelsApi,
    private val sessionStore: AuthSessionReader,
) {
    private suspend fun <T> request(action: (String, String) -> T): Result<T> = withContext(Dispatchers.IO) {
        runCatching {
            val origin = sessionStore.readServerUrl()
            val token = sessionStore.readAccessToken()
            check(origin.isNotBlank() && token.isNotBlank()) { "Sign in to the platform first." }
            action(origin, token)
        }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
    }

    suspend fun get() = request(agents::get)
    suspend fun prepare() = request(agents::prepare)
    suspend fun providers() = request(models::list)
    suspend fun save(providerId: String?, write: PersonalProviderWrite) = request { origin, token ->
        models.save(origin, token, providerId, write)
    }
    suspend fun remove(providerId: String) = request { origin, token -> models.remove(origin, token, providerId) }
    suspend fun verify(providerId: String) = request { origin, token -> models.verify(origin, token, providerId) }
    suspend fun default() = request(models::default)
    suspend fun catalog() = request(models::catalog)
    suspend fun setDefault(selection: PersonalModelSelection?) = request { origin, token -> models.setDefault(origin, token, selection) }
}
