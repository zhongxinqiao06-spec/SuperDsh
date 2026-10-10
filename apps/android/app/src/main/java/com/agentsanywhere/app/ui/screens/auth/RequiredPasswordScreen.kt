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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import kotlinx.coroutines.launch

@Composable
fun RequiredPasswordScreen(onChangePassword: suspend (String) -> Result<Unit>, onSignOut: () -> Unit) {
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    ScreenScaffold {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text(stringResource(R.string.identity_reset_title))
            Text(stringResource(R.string.identity_reset_hint))
            OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.identity_new_password)) },
                visualTransformation = PasswordVisualTransformation(), singleLine = true, enabled = !busy,
                modifier = Modifier.fillMaxWidth())
            OutlinedTextField(confirm, { confirm = it }, label = { Text(stringResource(R.string.identity_confirm_password)) },
                visualTransformation = PasswordVisualTransformation(), singleLine = true, enabled = !busy,
                modifier = Modifier.fillMaxWidth())
            error?.let { Text(it) }
            Button(enabled = !busy && password.length >= 8 && password == confirm, onClick = {
                busy = true
                scope.launch {
                    onChangePassword(password).onSuccess { password = ""; confirm = "" }
                        .onFailure { error = it.message }
                    busy = false
                }
            }) { Text(stringResource(R.string.identity_change_and_sign_in)) }
            TextButton(onClick = onSignOut, enabled = !busy) { Text(stringResource(R.string.identity_sign_out)) }
        }
    }
}
