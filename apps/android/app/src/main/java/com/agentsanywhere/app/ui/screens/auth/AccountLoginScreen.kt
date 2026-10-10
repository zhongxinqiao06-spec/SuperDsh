package com.agentsanywhere.app.ui.screens.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.normalizeServerOrigin
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

@Composable
fun AccountLoginScreen(navigate: (AppDestination) -> Unit) {
    val context = LocalContext.current
    val store = remember(context) { AuthSessionStore(context) }
    var server by remember { mutableStateOf(store.readServerUrl()) }
    var identifier by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    ScreenScaffold {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(stringResource(R.string.identity_account_login))
            OutlinedTextField(server, { server = it }, label = { Text(stringResource(R.string.identity_server)) },
                singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(identifier, { identifier = it }, label = { Text(stringResource(R.string.identity_identifier)) },
                singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.identity_password)) },
                singleLine = true, enabled = !busy, visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth())
            Text(stringResource(R.string.identity_login_hint))
            error?.let { Text(it) }
            Button(enabled = !busy && identifier.isNotBlank() && password.isNotBlank() && normalizeServerOrigin(server) != null,
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            val origin = requireNotNull(normalizeServerOrigin(server))
                            val auth = withContext(Dispatchers.IO) { AuthApi().login(origin, identifier, password) }
                            currentCoroutineContext().ensureActive()
                            store.saveAuthSession(origin, auth)
                            password = ""
                            navigate(AppDestination.Sessions)
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (failure: Exception) { error = failure.message }
                        finally { busy = false }
                    }
                }) { Text(stringResource(R.string.identity_sign_in)) }
            TextButton(onClick = { navigate(AppDestination.ServerSetup) }, enabled = !busy) {
                Text(stringResource(R.string.identity_web_login))
            }
            TextButton(onClick = { navigate(AppDestination.LoginMethods) }, enabled = !busy) {
                Text(stringResource(R.string.common_back))
            }
        }
    }
}
