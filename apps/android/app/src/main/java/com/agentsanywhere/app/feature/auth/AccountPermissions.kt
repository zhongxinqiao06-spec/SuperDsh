package com.agentsanywhere.app.feature.auth

import androidx.compose.runtime.staticCompositionLocalOf
import com.agentsanywhere.app.navigation.AppDestination

val LocalAccountPermissions = staticCompositionLocalOf<Set<String>> { emptySet() }

fun Set<String>.allowsDestination(destination: AppDestination): Boolean = when (destination) {
    AppDestination.Devices, AppDestination.DeviceDetail -> "devices.read" in this
    AppDestination.DeviceSetup -> "devices.manage" in this
    AppDestination.NewSession -> "sessions.run" in this
    AppDestination.NewProject -> "projects.manage" in this
    AppDestination.SessionDetail, AppDestination.ArchivedSessions -> "sessions.read" in this
    AppDestination.Files -> "files.read" in this
    AppDestination.Terminal -> "terminal.use" in this
    AppDestination.PersonalModels -> "models.personal.manage" in this
    else -> true
}
