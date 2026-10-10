package com.agentsanywhere.app.ui.screens.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.PersonalModel
import com.agentsanywhere.app.api.PersonalModelSelection
import com.agentsanywhere.app.api.PersonalProvider
import com.agentsanywhere.app.api.PersonalProviderWrite
import com.agentsanywhere.app.feature.sessions.ServerAgentController
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import kotlinx.coroutines.launch

@Composable
fun PersonalModelsScreen(controller: ServerAgentController, onBack: () -> Unit) {
    var providers by remember { mutableStateOf<List<PersonalProvider>>(emptyList()) }
    var default by remember { mutableStateOf<PersonalModelSelection?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var revision by remember { mutableStateOf(0) }
    var editing by remember { mutableStateOf<PersonalProvider?>(null) }
    var formOpen by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var protocol by remember { mutableStateOf("openai-completions") }
    var baseUrl by remember { mutableStateOf("") }
    var modelIds by remember { mutableStateOf("") }
    // API keys exist only in this transient form, never saved to Android preferences or drafts.
    var apiKey by remember { mutableStateOf("") }
    var enabled by remember { mutableStateOf(true) }
    var pendingDelete by remember { mutableStateOf<PersonalProvider?>(null) }
    val scope = rememberCoroutineScope()
    val verified = stringResource(R.string.personal_models_verified)

    LaunchedEffect(revision) {
        loading = true
        error = null
        controller.providers().onSuccess { providers = it }.onFailure { error = it.message }
        if (error == null) controller.default().onSuccess { default = it }.onFailure { error = it.message }
        loading = false
    }

    fun beginEdit(provider: PersonalProvider?) {
        editing = provider
        name = provider?.name.orEmpty()
        protocol = provider?.protocol ?: "openai-completions"
        baseUrl = provider?.baseUrl.orEmpty()
        modelIds = provider?.models?.joinToString("\n") { it.modelId }.orEmpty()
        apiKey = ""
        enabled = provider?.enabled ?: true
        error = null
        formOpen = true
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onBack) { Text(stringResource(R.string.common_back)) }
        Text(stringResource(R.string.personal_models_title), color = LocalAAColors.current.ink)
        Text(stringResource(R.string.personal_models_description), color = LocalAAColors.current.inkSoft)
        if (loading) CircularProgressIndicator()
        error?.let { Text(it, color = LocalAAColors.current.errorText) }
        notice?.let { Text(it) }
        Row {
            OutlinedButton(enabled = !busy && !loading, onClick = { revision++ }) { Text(stringResource(R.string.personal_models_refresh)) }
            OutlinedButton(enabled = !busy && !loading, onClick = { beginEdit(null) }) { Text(stringResource(R.string.personal_models_add)) }
        }
        providers.forEach { provider ->
            ProfileCard {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(provider.name)
                    Text("${provider.protocol} · ${provider.baseUrl}", color = LocalAAColors.current.inkSoft)
                    Text(stringResource(if (provider.apiKeyConfigured) R.string.personal_models_key_configured else R.string.personal_models_key_missing))
                    Row {
                        TextButton(enabled = !busy, onClick = { beginEdit(provider) }) { Text(stringResource(R.string.personal_models_edit)) }
                        TextButton(enabled = !busy, onClick = {
                            scope.launch {
                                busy = true
                                error = null
                                controller.verify(provider.providerId).onSuccess { notice = verified }.onFailure { error = it.message }
                                busy = false
                            }
                        }) { Text(stringResource(R.string.personal_models_verify)) }
                        TextButton(enabled = !busy, onClick = { pendingDelete = provider }) { Text(stringResource(R.string.personal_models_delete)) }
                    }
                    provider.models.forEach { model ->
                        val selected = default?.providerId == provider.providerId && default?.modelId == model.modelId
                        TextButton(enabled = !busy && provider.enabled && !selected, onClick = {
                            scope.launch {
                                busy = true
                                controller.setDefault(PersonalModelSelection(provider.providerId, model.modelId))
                                    .onSuccess { revision++ }.onFailure { error = it.message }
                                busy = false
                            }
                        }) { Text(model.name + if (selected) " · " + stringResource(R.string.personal_models_default) else " · " + stringResource(R.string.personal_models_set_default)) }
                    }
                }
            }
        }
        if (default != null) TextButton(enabled = !busy, onClick = {
            scope.launch {
                busy = true
                controller.setDefault(null).onSuccess { revision++ }.onFailure { error = it.message }
                busy = false
            }
        }) { Text(stringResource(R.string.personal_models_use_platform)) }
        if (formOpen) {
            OutlinedTextField(name, onValueChange = { name = it }, label = { Text(stringResource(R.string.personal_models_name)) }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            Text(stringResource(R.string.personal_models_protocol))
            listOf("openai-completions", "openai-responses", "anthropic-messages").forEach { value ->
                TextButton(enabled = !busy, onClick = { protocol = value }) { Text((if (protocol == value) "✓ " else "") + value) }
            }
            OutlinedTextField(baseUrl, onValueChange = { baseUrl = it }, label = { Text(stringResource(R.string.personal_models_url)) }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(modelIds, onValueChange = { modelIds = it }, label = { Text(stringResource(R.string.personal_models_ids)) }, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(apiKey, onValueChange = { apiKey = it }, label = { Text(stringResource(R.string.personal_models_key)) },
                supportingText = { Text(stringResource(R.string.personal_models_key_hint)) }, visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), singleLine = true,
                enabled = !busy, modifier = Modifier.fillMaxWidth())
            Row {
                Text(stringResource(R.string.personal_models_enabled))
                Switch(checked = enabled, onCheckedChange = { enabled = it }, enabled = !busy)
            }
            Row {
                Button(enabled = !busy && name.isNotBlank() && baseUrl.isNotBlank() && modelIds.isNotBlank(), onClick = {
                    scope.launch {
                        busy = true
                        error = null
                        val models = modelIds.lines().map(String::trim).filter(String::isNotBlank).distinct().map { id ->
                            editing?.models?.firstOrNull { it.modelId == id } ?: PersonalModel(id, id)
                        }
                        controller.save(editing?.providerId, PersonalProviderWrite(name, protocol, baseUrl, models, enabled, apiKey.takeIf(String::isNotBlank)))
                            .onSuccess { apiKey = ""; formOpen = false; revision++ }.onFailure { error = it.message }
                        busy = false
                    }
                }) { Text(stringResource(R.string.personal_models_save)) }
                TextButton(enabled = !busy, onClick = { apiKey = ""; formOpen = false }) { Text(stringResource(R.string.common_cancel)) }
            }
        }
    }
    pendingDelete?.let { provider ->
        AlertDialog(onDismissRequest = { if (!busy) pendingDelete = null }, title = { Text(stringResource(R.string.personal_models_delete)) },
            text = { Text(stringResource(R.string.personal_models_delete_hint, provider.name)) },
            confirmButton = { TextButton(enabled = !busy, onClick = {
                scope.launch {
                    busy = true
                    controller.remove(provider.providerId).onSuccess { pendingDelete = null; revision++ }.onFailure { error = it.message }
                    busy = false
                }
            }) { Text(stringResource(R.string.personal_models_delete)) } },
            dismissButton = { TextButton(enabled = !busy, onClick = { pendingDelete = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}
